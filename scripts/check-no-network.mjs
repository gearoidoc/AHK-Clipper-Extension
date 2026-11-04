// Fails if anything in the extension or the native host could reach the
// network. BRIEF.md "Privacy: local only" lists the rules this enforces.
//
//   1. No network API in the extension source or the bundled dist/.
//   2. No remote URL in dist/ (remote code, fonts, styles or images).
//   3. The manifest keeps the local-only shape: CSP, permissions, no update_url.
//   4. `go list -deps` for the host includes no networking package.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const NETWORK_APIS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket(Stream)?\b/,
  /\bEventSource\b/,
  /\bsendBeacon\b/,
  /\bimportScripts\b/,
  /\bRTCPeerConnection\b/,
  /\bWebTransport\b/,
  /\bstorage\.sync\b/, // Syncs settings to the Google account.
];
const REMOTE_URL = /\b(?:https?|wss?|ftp):\/\//i;

const ALLOWED_PERMISSIONS = new Set(['contextMenus', 'nativeMessaging', 'storage', 'activeTab', 'scripting']);
const REQUIRED_CSP = "default-src 'self'; script-src 'self'; object-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'";
const FORBIDDEN_GO_PACKAGE = /^(net|net\/.+|crypto\/tls|vendor\/golang\.org\/x\/net\/.+)$/;

const problems = [];

function* files(dir, extensions) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path, extensions);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) yield path;
  }
}

function scan(dir, extensions, patterns) {
  for (const path of files(join(root, dir), extensions)) {
    readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
      for (const pattern of patterns) {
        if (pattern.test(line)) problems.push(`${relative(root, path)}:${i + 1}: matches ${pattern}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
}

scan('extension/src', ['.ts', '.js', '.html', '.css'], NETWORK_APIS);
if (!existsSync(join(root, 'dist/manifest.json'))) {
  problems.push('dist/ is missing; run `npm run build` first so the bundled output is checked too.');
} else {
  scan('dist', ['.js', '.html', '.css', '.json'], [...NETWORK_APIS, REMOTE_URL]);
}

const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));
if (manifest.content_security_policy?.extension_pages !== REQUIRED_CSP) {
  problems.push(`manifest: extension_pages CSP must be exactly: ${REQUIRED_CSP}`);
}
for (const permission of manifest.permissions ?? []) {
  if (!ALLOWED_PERMISSIONS.has(permission)) problems.push(`manifest: permission "${permission}" is not in the brief's list`);
}
for (const key of ['host_permissions', 'optional_host_permissions', 'optional_permissions', 'update_url', 'externally_connectable']) {
  if (key in manifest) problems.push(`manifest: "${key}" is not allowed`);
}

for (const goos of ['windows', 'linux']) {
  const deps = execFileSync('go', ['list', '-deps', '.'], {
    cwd: join(root, 'host'),
    env: { ...process.env, GOOS: goos, GOARCH: 'amd64', CGO_ENABLED: '0' },
    encoding: 'utf8',
  }).split('\n');
  for (const pkg of deps.filter((d) => FORBIDDEN_GO_PACKAGE.test(d))) {
    problems.push(`host (GOOS=${goos}): depends on ${pkg}`);
  }
}

if (problems.length > 0) {
  console.error(`Network check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Network check passed: no network APIs, no remote URLs, local-only manifest, host has no net packages.');
