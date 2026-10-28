// One-off clean-ups of the shop's data. Kept apart from the API so nothing here can
// run by accident: scripts/ call these with an explicit --confirm.

// Designs made by remixing another design (they carry a link to their parent).
export async function findRemixedDesigns(store) {
  return store.list('designs', (design) => Boolean(design.remixedFrom));
}

// Deletes the remixed designs and tidies what pointed at them. Returns a summary.
// `backup` receives every document just before it is deleted, so nothing is lost.
export async function removeRemixedDesigns(store, { dryRun = true, backup = async () => {} } = {}) {
  const remixes = await findRemixedDesigns(store);
  const ids = new Set(remixes.map((d) => d.id));
  const likes = await store.list('likes', (like) => ids.has(String(like.id).split(':')[0]));
  const parents = new Map();
  for (const design of remixes) {
    if (design.remixedFrom?.id && !ids.has(design.remixedFrom.id)) {
      parents.set(design.remixedFrom.id, (parents.get(design.remixedFrom.id) ?? 0) + 1);
    }
  }

  const summary = { remixes: remixes.length, likes: likes.length, parentsToFix: parents.size };
  if (dryRun) return { ...summary, deleted: false, remixes: remixes };

  await backup({ designs: remixes, likes });
  for (const like of likes) await store.del('likes', like.id);
  for (const design of remixes) await store.del('designs', design.id);

  // A parent's remix count must not keep counting designs that are gone.
  for (const [parentId, removed] of parents) {
    const parent = await store.get('designs', parentId);
    if (parent) {
      parent.remixCount = Math.max(0, (parent.remixCount ?? 0) - removed);
      await store.put('designs', parent.id, parent);
    }
  }
  return { ...summary, deleted: true, remixes };
}
