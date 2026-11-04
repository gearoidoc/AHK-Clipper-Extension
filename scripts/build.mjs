// Builds the loadable unpacked extension into dist/.
// `--e2e` builds a test variant into .e2e/dist instead: it adds a hook the e2e
// test uses to open the dialog (tests can't press browser shortcuts) and host
// permissions for the local test server, which stand in for activeTab.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extensionId } from './extension-id.mjs';

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const e2e = process.argv.includes('--e2e');
const dist = root(e2e ? '.e2e/dist' : 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = {
  outdir: dist,
  bundle: true,
  target: 'chrome130',
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'warning',
  define: { __E2E__: String(e2e) },
  // Drops the `if (__E2E__)` block from the production build.
  minifySyntax: true,
};

await build({
  ...common,
  entryPoints: {
    background: root('extension/src/background.ts'),
    options: root('extension/src/options/options.ts'),
    dialog: root('extension/src/dialog/dialog.ts'),
  },
  format: 'esm',
});

// Injected with chrome.scripting.executeScript, which can't load modules.
await build({
  ...common,
  entryPoints: { 'dialog-host': root('extension/src/content/dialog-host.ts') },
  format: 'iife',
});

for (const file of ['options/options.html', 'options/options.css', 'dialog/dialog.html', 'dialog/dialog.css', 'theme.css']) {
  copyFileSync(root(`extension/src/${file}`), `${dist}/${file.split('/').pop()}`);
}

// package.json holds the one version number.
const { version } = JSON.parse(readFileSync(root('package.json'), 'utf8'));
const manifest = { ...JSON.parse(readFileSync(root('extension/manifest.json'), 'utf8')), version };
if (e2e) manifest.host_permissions = ['http://127.0.0.1/*'];
writeFileSync(`${dist}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');

console.log(`Built ${e2e ? '.e2e/dist' : 'dist'}/ (version ${version}, extension ID ${extensionId()})`);
