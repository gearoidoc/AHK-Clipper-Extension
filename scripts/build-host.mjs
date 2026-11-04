// Builds the native host: a Windows exe for release and a Linux binary for
// the e2e test. The version and extension ID are compiled in.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extensionId } from './extension-id.mjs';

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

export const HOST_BINARIES = {
  windows: 'host/bin/ahk-clipper-host.exe',
  linux: 'host/bin/ahk-clipper-host',
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(root('package.json'), 'utf8'));
  const ldflags = `-s -w -X main.version=${version} -X main.extensionID=${extensionId()}`;

  for (const [goos, output] of Object.entries(HOST_BINARIES)) {
    execFileSync('go', ['build', '-trimpath', '-ldflags', ldflags, '-o', root(output), '.'], {
      cwd: root('host'),
      env: { ...process.env, GOOS: goos, GOARCH: 'amd64', CGO_ENABLED: '0' },
      stdio: 'inherit',
    });
    console.log(`Built ${output}`);
  }
}
