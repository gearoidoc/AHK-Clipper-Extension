// End-to-end checks in Chrome for Testing on Linux, against the Linux build
// of the native host. The Windows install and real AutoHotkey are checked by
// hand (see the checklist in the README and the phase PRs).
import { HOST_BINARIES } from './build-host.mjs';
import { dialogSuite } from './e2e/dialog.mjs';
import { failures, requireBuilt } from './e2e/lib.mjs';
import { managerSuite } from './e2e/manager.mjs';
import { privacySuite } from './e2e/privacy.mjs';

requireBuilt(['dist/manifest.json', '.e2e/dist/manifest.json', HOST_BINARIES.linux]);

await privacySuite();
await dialogSuite();
await managerSuite();

if (failures.length > 0) {
  console.error(`\n${failures.length} e2e check(s) failed.`);
  process.exit(1);
}
console.log('\nAll e2e checks passed.');
