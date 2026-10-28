import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findRemixedDesigns, removeRemixedDesigns } from '../src/maintenance.js';
import { Store } from '../src/store.js';

async function shop() {
  const store = await new Store(':memory:').load();
  const put = (id, extra = {}) => store.put('designs', id, { id, name: id, published: true, remixCount: 0, ...extra });
  await put('original', { remixCount: 2 });
  await put('remix1', { remixedFrom: { id: 'original', handle: 'ada', name: 'original' } });
  await put('remix2', { remixedFrom: { id: 'original', handle: 'ada', name: 'original' }, published: false });
  await put('other');
  await store.put('likes', 'remix1:u1', { id: 'remix1:u1' });
  await store.put('likes', 'original:u1', { id: 'original:u1' });
  return store;
}

describe('removing remixed designs', () => {
  it('a dry run lists them and changes nothing', async () => {
    const store = await shop();
    const result = await removeRemixedDesigns(store);
    assert.equal(result.deleted, false);
    assert.deepEqual(result.remixes.map((d) => d.id).sort(), ['remix1', 'remix2']);
    assert.equal((await store.list('designs')).length, 4);
  });

  it('deletes remixes and their likes, fixes the original, and backs up first', async () => {
    const store = await shop();
    let saved;
    const result = await removeRemixedDesigns(store, { dryRun: false, backup: async (data) => { saved = data; } });

    assert.equal(result.deleted, true);
    assert.deepEqual(saved.designs.map((d) => d.id).sort(), ['remix1', 'remix2'], 'backed up before deleting');
    assert.deepEqual((await store.list('designs')).map((d) => d.id).sort(), ['original', 'other']);
    assert.deepEqual((await store.list('likes')).map((l) => l.id), ['original:u1'], 'only the remix like went');
    assert.equal((await store.get('designs', 'original')).remixCount, 0);
    assert.equal((await findRemixedDesigns(store)).length, 0);
  });
});
