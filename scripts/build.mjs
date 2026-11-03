// Builds the loadable unpacked extension into dist/.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extensionId } from './extension-id.mjs';

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const dist = root('dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

await build({
  entryPoints: {
    background: root('extension/src/background.ts'),
    options: root('extension/src/options/options.ts'),
  },
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'warning',
});

for (const file of ['options.html', 'options.css']) {
  copyFileSync(root(`extension/src/options/${file}`), `${dist}/${file}`);
}

// package.json holds the one version number.
const { version } = JSON.parse(readFileSync(root('package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(root('extension/manifest.json'), 'utf8'));
writeFileSync(`${dist}/manifest.json`, JSON.stringify({ ...manifest, version }, null, 2) + '\n');

console.log(`Built dist/ (version ${version}, extension ID ${extensionId()})`);
