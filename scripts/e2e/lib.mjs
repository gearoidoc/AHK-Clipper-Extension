// Shared pieces of the e2e suites: Chrome for Testing, a local server that
// records every request, native host registration and result reporting.
import { getInstalledBrowsers } from '@puppeteer/browsers';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { HOST_BINARIES } from '../build-host.mjs';
import { extensionId, HOST_NAME } from '../extension-id.mjs';

export const root = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
export const id = extensionId();
export const failures = [];

export function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? `  (${String(detail).replace(/\s+/g, ' ').slice(0, 220)})` : ''}`);
  if (!ok) failures.push(name);
  return ok;
}

export function requireBuilt(paths) {
  for (const path of paths) {
    if (!existsSync(root(path))) {
      console.error(`Missing ${path}; run \`npm run build && npm run build:e2e && npm run build:host\` first.`);
      process.exit(1);
    }
  }
}

export async function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cacheDir = process.env.CHROME_CACHE ?? join(homedir(), '.cache/chrome-for-testing');
  const installed = (await getInstalledBrowsers({ cacheDir })).filter((b) => b.browser === 'chrome');
  installed.sort((a, b) => b.buildId.localeCompare(a.buildId, 'en', { numeric: true }));
  if (installed.length === 0) {
    console.error(`No Chrome for Testing in ${cacheDir}. Install it with:\n  npx @puppeteer/browsers install chrome@stable --path ${cacheDir}`);
    process.exit(1);
  }
  return installed[0].executablePath;
}

/**
 * Starts a server on 127.0.0.1 that records every request path in `hits`.
 * `pages` maps a path to { body, headers }; anything else gets "hit".
 */
export async function startServer(pages = {}) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const page = pages[req.url];
    res.writeHead(200, page
      ? { 'content-type': 'text/html; charset=utf-8', ...page.headers }
      : { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end(page ? page.body : 'hit');
  });
  server.on('upgrade', (req, socket) => {
    hits.push(req.url);
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() };
}

/**
 * A fresh Chrome profile. Chrome on Linux reads per-user native host
 * manifests from <user data dir>/NativeMessagingHosts.
 */
export function makeProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'ahk-clipper-e2e-'));
  const hostManifest = join(dir, 'NativeMessagingHosts', `${HOST_NAME}.json`);
  const registerHost = (allowedId = id) => {
    mkdirSync(join(dir, 'NativeMessagingHosts'), { recursive: true });
    writeFileSync(hostManifest, JSON.stringify({
      name: HOST_NAME,
      description: 'AHK Hotstring Clipper native host (e2e)',
      path: root(HOST_BINARIES.linux),
      type: 'stdio',
      allowed_origins: [`chrome-extension://${allowedId}/`],
    }));
  };
  return { dir, hostManifest, registerHost, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function launch(extensionDir, profileDir) {
  return puppeteer.launch({
    executablePath: await findChrome(),
    headless: true,
    pipe: true,
    userDataDir: profileDir,
    enableExtensions: [extensionDir],
    args: ['--no-first-run', '--no-default-browser-check', ...(process.env.E2E_NO_SANDBOX ? ['--no-sandbox'] : [])],
  });
}

export function serviceWorker(browser) {
  return browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://') && t.url().endsWith('/background.js'),
    { timeout: 15_000 },
  );
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `fn` until it returns something truthy, or gives up and returns the last value. */
export async function waitFor(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    if ((value = await fn())) return value;
    await sleep(50);
  }
  return value;
}
