// Packages what the Windows PC needs into release/ahk-hotstring-clipper-<version>.zip:
//   extension/          the unpacked extension (dist/) for Load unpacked
//   host/               ahk-clipper-host.exe
//   install.ps1, uninstall.ps1, extension-id.txt, README.md
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HOST_BINARIES } from './build-host.mjs';
import { extensionId } from './extension-id.mjs';

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

for (const path of ['dist/manifest.json', HOST_BINARIES.windows]) {
  if (!existsSync(root(path))) {
    console.error(`Missing ${path}; run \`npm run release\` rather than this script directly.`);
    process.exit(1);
  }
}

const { version } = JSON.parse(readFileSync(root('package.json'), 'utf8'));
const name = `ahk-hotstring-clipper-${version}`;
const stage = root(`release/${name}`);

rmSync(stage, { recursive: true, force: true });
rmSync(`${stage}.zip`, { force: true });
mkdirSync(`${stage}/host`, { recursive: true });

cpSync(root('dist'), `${stage}/extension`, { recursive: true });
cpSync(root(HOST_BINARIES.windows), `${stage}/host/ahk-clipper-host.exe`);
for (const script of ['install.ps1', 'uninstall.ps1']) {
  // CRLF so the scripts open cleanly in Windows editors.
  writeFileSync(`${stage}/${script}`, readFileSync(root(`installer/${script}`), 'utf8').replace(/\r?\n/g, '\r\n'));
}
writeFileSync(`${stage}/extension-id.txt`, `${extensionId()}\r\n`);
cpSync(root('README.md'), `${stage}/README.md`);

execFileSync('zip', ['-r', '-X', '-q', `${name}.zip`, name], { cwd: root('release'), stdio: 'inherit' });
console.log(`Packaged release/${name}.zip`);
