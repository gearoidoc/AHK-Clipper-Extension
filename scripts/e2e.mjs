// End-to-end check in Chrome for Testing on Linux, against the Linux build of
// the native host. Covers what Phase 0 promises on the Chrome side:
//   - the unpacked extension gets the fixed ID derived from the manifest key
//   - Test connection reaches the host and gets its echo back
//   - missing or mis-registered hosts produce the friendly errors
//   - the CSP blocks every network API from the service worker and the
//     options page, and a ping makes no http(s)/ws requests
// The Windows registry install is checked by hand (see README).
import { getInstalledBrowsers } from '@puppeteer/browsers';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { HOST_BINARIES } from './build-host.mjs';
import { extensionId, HOST_NAME } from './extension-id.mjs';

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const id = extensionId();
const failures = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

async function findChrome() {
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

for (const [what, path] of [['dist/', root('dist/manifest.json')], ['the Linux host', root(HOST_BINARIES.linux)]]) {
  if (!existsSync(path)) {
    console.error(`Missing ${what}; run \`npm run build && npm run build:host\` first.`);
    process.exit(1);
  }
}

// A local server that records every request, so "blocked" means it never arrived.
const hits = [];
const server = createServer((req, res) => {
  hits.push(req.url);
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end('hit');
});
server.on('upgrade', (req, socket) => {
  hits.push(req.url);
  socket.destroy();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// Chrome on Linux reads per-user native host manifests from <user data dir>/NativeMessagingHosts.
const userDataDir = mkdtempSync(join(tmpdir(), 'ahk-clipper-e2e-'));
const hostManifest = join(userDataDir, 'NativeMessagingHosts', `${HOST_NAME}.json`);
function registerHost(allowedId) {
  mkdirSync(join(userDataDir, 'NativeMessagingHosts'), { recursive: true });
  writeFileSync(hostManifest, JSON.stringify({
    name: HOST_NAME,
    description: 'AHK Hotstring Clipper native host (e2e)',
    path: root(HOST_BINARIES.linux),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${allowedId}/`],
  }));
}

// Runs inside the page or worker under test; every probe targets `${base}/${label}/...`.
async function probeNetwork(base, label) {
  const url = (kind) => `${base}/${label}/${kind}`;
  const settle = (promise) => promise.then(() => 'allowed', (e) => `blocked (${e?.message ?? e})`);
  const event = (start) => new Promise((resolve) => {
    try {
      start(resolve);
    } catch (e) {
      resolve(`blocked (${e.message})`);
    }
    setTimeout(() => resolve('no answer'), 3000);
  });
  const results = {};
  results.fetch = await settle(fetch(url('fetch')));
  results.websocket = await event((done) => {
    const ws = new WebSocket(url('websocket').replace(/^http/, 'ws'));
    ws.onopen = () => done('allowed');
    ws.onerror = () => done('blocked');
  });
  results.import = await settle(import(url('import')));
  if (typeof document !== 'undefined') {
    results.xhr = await event((done) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url('xhr'));
      xhr.onload = () => done('allowed');
      xhr.onerror = () => done('blocked');
      xhr.send();
    });
    results.eventsource = await event((done) => {
      const es = new EventSource(url('eventsource'));
      es.onopen = () => done('allowed');
      es.onerror = () => { es.close(); done('blocked'); };
    });
    results.beacon = navigator.sendBeacon(url('beacon'), 'x') ? 'queued' : 'refused';
    results.image = await event((done) => {
      const img = new Image();
      img.onload = () => done('allowed');
      img.onerror = () => done('blocked');
      img.src = url('image');
    });
    results.stylesheet = await event((done) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.onload = () => done('allowed');
      link.onerror = () => done('blocked');
      link.href = url('stylesheet');
      document.head.append(link);
    });
    results.iframe = await event((done) => {
      const frame = document.createElement('iframe');
      frame.onload = () => done('loaded');
      frame.src = url('iframe');
      document.body.append(frame);
    });
  }
  return results;
}

const executablePath = await findChrome();
registerHost(id);
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  pipe: true,
  userDataDir,
  enableExtensions: [root('dist')],
  args: ['--no-first-run', '--no-default-browser-check', ...(process.env.E2E_NO_SANDBOX ? ['--no-sandbox'] : [])],
});

try {
  console.log(`Chrome ${await browser.version()} (${executablePath})`);

  const worker = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://') && t.url().endsWith('/background.js'),
    { timeout: 15_000 },
  );
  const loadedId = new URL(worker.url()).host;
  check('the extension ID is fixed by the manifest key', loadedId === id, loadedId);

  // Record every request the service worker and options page make.
  const requests = [];
  const workerSession = await worker.createCDPSession();
  await workerSession.send('Network.enable');
  workerSession.on('Network.requestWillBeSent', (e) => requests.push(`worker ${e.request.url}`));

  const page = await browser.newPage();
  page.on('request', (r) => requests.push(`options ${r.url()}`));
  await page.goto(`chrome-extension://${id}/options.html`);

  async function testConnection() {
    await page.click('#test-connection');
    await page.waitForSelector('#connection-result:is([data-state="ok"], [data-state="error"])', { timeout: 15_000 });
    return page.$eval('#connection-result', (el) => ({ state: el.dataset.state, code: el.dataset.code, text: el.innerText }));
  }

  requests.length = 0;
  const ping = await testConnection();
  check('Test connection reaches the host', ping.state === 'ok' && /Connected to host 0\.\d+\.\d+/.test(ping.text), ping.text.replace(/\s+/g, ' '));
  check('the host echoes the message back', /Echo\s+matched/.test(ping.text));
  const remote = requests.filter((r) => !/ chrome-extension:\/\//.test(r));
  check('a ping makes no http(s) or ws requests', remote.length === 0, remote.join(', '));

  rmSync(hostManifest);
  const missing = await testConnection();
  check('a missing host gives the install hint', missing.state === 'error' && missing.code === 'host_missing', missing.text);

  registerHost('a'.repeat(32));
  const forbidden = await testConnection();
  check('a host registered for another ID is reported', forbidden.state === 'error' && forbidden.code === 'host_forbidden', forbidden.text);
  registerHost(id);

  // Network probes: an ordinary web page first, to prove each probe reaches the
  // server when nothing blocks it, then the two extension contexts.
  const control = await browser.newPage();
  await control.goto(`${base}/control/page`);
  const controlResults = await control.evaluate(probeNetwork, base, 'control');
  const sw = await worker.worker();
  const workerResults = await sw.evaluate(probeNetwork, base, 'worker');
  const optionsResults = await page.evaluate(probeNetwork, base, 'options');
  await new Promise((resolve) => setTimeout(resolve, 1000));

  for (const kind of Object.keys(optionsResults)) {
    const reached = (label) => hits.some((h) => h.startsWith(`/${label}/${kind}`));
    if (!reached('control')) {
      check(`control: ${kind} reaches the server from a web page`, false, controlResults[kind]);
      continue;
    }
    if (kind in workerResults) {
      check(`${kind} from the service worker never reaches the server`, !reached('worker'), workerResults[kind]);
    }
    check(`${kind} from the options page never reaches the server`, !reached('options'), optionsResults[kind]);
  }
  const strays = hits.filter((h) => !h.startsWith('/control/') && h !== '/favicon.ico');
  check('the server saw no requests from the extension', strays.length === 0, strays.join(', '));
} finally {
  await browser.close();
  server.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} e2e check(s) failed.`);
  process.exit(1);
}
console.log('\nAll e2e checks passed.');
