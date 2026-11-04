// Derives the extension ID that Chrome assigns from the manifest `key`.
// Run directly to print it: `node scripts/extension-id.mjs`.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HOST_NAME = 'com.gearoid.ahk_clipper';

const MANIFEST = fileURLToPath(new URL('../extension/manifest.json', import.meta.url));

// Chrome hashes the DER-encoded public key with SHA-256, keeps the first
// 32 hex digits and maps 0-f onto a-p.
export function extensionIdFromKey(base64Key) {
  const hex = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function extensionId() {
  const { key } = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (!key) throw new Error(`${MANIFEST} has no "key"`);
  return extensionIdFromKey(key);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(extensionId());
}
