#!/usr/bin/env node
// Lists, then (only with --confirm) deletes, the remixed community designs stored in
// SethuCMS (the dw_store collection). Always writes a backup file first.
//
//   set -a; . ./.env; set +a                  # SETHUCMS_URL, SETHUCMS_CONNECTION_ID
//   export SETHUCMS_STORE_TOKEN=...           # the read-write token for dw_store
//   node scripts/delete-remixed-designs.mjs             # dry run: only lists
//   node scripts/delete-remixed-designs.mjs --confirm   # backs up, then deletes
//
// It talks to the SethuCMS store directly, whatever other database settings are in
// your environment.
import { mkdir, writeFile } from 'node:fs/promises';

import { removeRemixedDesigns } from '../src/maintenance.js';
import { SethuStore } from '../src/store.js';

const settings = {
  url: (process.env.SETHUCMS_URL ?? '').replace(/\/+$/, ''),
  connectionId: process.env.SETHUCMS_STORE_CONNECTION_ID ?? process.env.SETHUCMS_CONNECTION_ID ?? '',
  token: process.env.SETHUCMS_STORE_TOKEN ?? '',
  collection: process.env.SETHUCMS_STORE_COLLECTION ?? 'dw_store',
};
if (!settings.url || !settings.connectionId || !settings.token) {
  console.error('Set SETHUCMS_URL, SETHUCMS_CONNECTION_ID and SETHUCMS_STORE_TOKEN first.');
  process.exit(1);
}

const confirm = process.argv.includes('--confirm');
const store = new SethuStore(settings);

const backupFile = `./.data/removed-remixes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const result = await removeRemixedDesigns(store, {
  dryRun: !confirm,
  backup: async (data) => {
    await mkdir('./.data', { recursive: true });
    await writeFile(backupFile, JSON.stringify(data), { mode: 0o600 });
    console.log(`Backup written to ${backupFile}`);
  },
});

for (const d of result.remixes) {
  console.log(`${d.id}  ${d.published ? 'published' : 'draft    '}  ${d.handle ?? '?'}  "${d.name}"  (remix of ${d.remixedFrom?.handle ?? '?'})`);
}
console.log(`\n${result.remixes.length} remixed design(s), ${result.likes} like(s), ${result.parentsToFix} original(s) whose remix count changes.`);
console.log(confirm ? 'Deleted.' : 'Dry run: nothing was deleted. Run again with --confirm to delete.');
