// Community designs: publish, browse, delete, like, and remix.
import { newId } from '../context.js';
import * as v from '../validate.js';
import { HttpError, bad } from '../validate.js';

const DEFAULT_BASE_COLOR = 0xffffffff;
const MAX_LINEAGE = 10;
const DESIGN_BODY_MAX_BYTES = 1_500_000;

// "Ada Lovelace" -> "adalovelace"
function handleOf(name) {
  const handle = name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
  return handle || 'designer';
}

export function registerDesignRoutes(router, ctx, presenters) {
  const { store, now } = ctx;
  const { publicDesign, isOpen } = presenters;

  // The challenge a new design enters, if it names one. Designs only enter a
  // challenge when first published into one that is open.
  function challengeForNewDesign(body) {
    if (!body.challengeId) return null;

    const challenge = store.get('challenges', String(body.challengeId));
    if (!challenge || !isOpen(challenge)) {
      throw bad('challenge_closed', 'That challenge is not open.');
    }
    if (body.published !== true) {
      throw bad('challenge_needs_publish', 'Challenge entries must be published.');
    }
    return challenge;
  }

  // Remixing records where the design came from and bumps the parent's count.
  async function remixOf(parentId) {
    const parent = store.get('designs', String(parentId));
    if (!parent || !parent.published) {
      throw bad('unknown_design', 'The design you are remixing is not available.');
    }

    const link = { id: parent.id, handle: parent.handle, name: parent.name };
    parent.remixCount += 1;
    await store.put('designs', parent.id, parent);

    return {
      remixedFrom: link,
      lineage: [...(parent.lineage ?? []), link].slice(-MAX_LINEAGE),
    };
  }

  router.route('POST', '/v1/designs', async ({ req }) => {
    const user = ctx.authed(req);
    ctx.limit(`design:${user.id}`, 60, 3600_000);
    const body = await ctx.readBody(req, DESIGN_BODY_MAX_BYTES);

    const garment = v.garmentName(body.garment ?? '');
    if (!(garment in v.GARMENT_PRICES)) throw bad('invalid_garment');

    const existing = body.id ? store.get('designs', String(body.id)) : null;
    if (existing && existing.ownerId !== user.id) {
      throw new HttpError(403, 'forbidden');
    }

    let challengeId = existing?.challengeId ?? null;
    let remixedFrom = existing?.remixedFrom ?? null;
    let lineage = existing?.lineage ?? [];

    if (!existing) {
      challengeId = challengeForNewDesign(body)?.id ?? null;
      if (body.remixOf) ({ remixedFrom, lineage } = await remixOf(body.remixOf));
    }

    const design = {
      id: existing?.id ?? newId('d_'),
      ownerId: user.id,
      ownerName: user.name,
      handle: handleOf(user.name),
      name: v.str(body.name, 'name', { max: 60 }),
      garment,
      baseColor: Number.isInteger(body.baseColor) ? body.baseColor >>> 0 : DEFAULT_BASE_COLOR,
      front: v.elements(body.front),
      back: v.elements(body.back),
      // The Design Studio's own format (richer than front/back elements) plus
      // rendered previews. An update that omits them keeps what was saved.
      designJson: v.studioDesign(body.designJson) ?? existing?.designJson ?? null,
      previewImage:
        v.preview(body.previewImage, 'previewImage') ?? existing?.previewImage ?? null,
      backPreviewImage:
        v.preview(body.backPreviewImage, 'backPreviewImage') ?? existing?.backPreviewImage ?? null,
      published: body.published === true,
      likeCount: existing?.likeCount ?? 0,
      remixCount: existing?.remixCount ?? 0,
      remixedFrom,
      lineage,
      challengeId,
      createdAt: existing?.createdAt ?? new Date(now()).toISOString(),
    };
    await store.put('designs', design.id, design);

    return {
      status: existing ? 200 : 201,
      body: { design: publicDesign(design, user.id) },
    };
  });

  router.route('GET', '/v1/designs', async ({ req, query }) => {
    const user = ctx.optionalUser(req);
    const onlyMine = query.get('mine') === '1';
    if (onlyMine && !user) throw new HttpError(401, 'unauthenticated');

    const designs = store.list('designs', (d) =>
      onlyMine ? d.ownerId === user.id : d.published,
    );

    const popularity = (d) => d.likeCount + d.remixCount;
    designs.sort(
      query.get('sort') === 'popular'
        ? (a, b) => popularity(b) - popularity(a)
        : (a, b) => b.createdAt.localeCompare(a.createdAt),
    );

    const max = Math.min(Number(query.get('limit')) || 30, 100);
    return {
      status: 200,
      body: { designs: designs.slice(0, max).map((d) => publicDesign(d, user?.id)) },
    };
  });

  router.route('GET', '/v1/designs/:designId', async ({ req, params }) => {
    const user = ctx.optionalUser(req);
    const design = store.get('designs', params.designId);

    const visible = design && (design.published || design.ownerId === user?.id);
    if (!visible) throw new HttpError(404, 'not_found');

    return { status: 200, body: { design: publicDesign(design, user?.id) } };
  });

  router.route('DELETE', '/v1/designs/:designId', async ({ req, params }) => {
    const user = ctx.authed(req);
    const design = store.get('designs', params.designId);
    if (!design || design.ownerId !== user.id) {
      throw new HttpError(404, 'not_found');
    }

    await store.del('designs', design.id);
    return { status: 200, body: { ok: true } };
  });

  // Toggles: liking an already-liked design removes the like.
  router.route('POST', '/v1/designs/:designId/like', async ({ req, params }) => {
    const user = ctx.authed(req);
    const design = store.get('designs', params.designId);
    if (!design || !design.published) throw new HttpError(404, 'not_found');

    const key = `${design.id}:${user.id}`;
    const liked = !store.get('likes', key);
    if (liked) {
      await store.put('likes', key, { id: key });
    } else {
      await store.del('likes', key);
    }

    design.likeCount = Math.max(0, design.likeCount + (liked ? 1 : -1));
    await store.put('designs', design.id, design);

    return { status: 200, body: { liked, likeCount: design.likeCount } };
  });
}
