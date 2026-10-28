// Weekly design challenges.
import { safeEqual } from '../security.js';
import * as v from '../validate.js';
import { HttpError, bad } from '../validate.js';

const MAX_ENTRIES_SHOWN = 50;

export function registerChallengeRoutes(router, ctx, presenters) {
  const { config, store } = ctx;
  const { publicDesign, isOpen, entriesOf, publicChallenge } = presenters;

  router.route('GET', '/v1/challenges/current', async () => {
    const newestFirst = (a, b) => b.startsAt.localeCompare(a.startsAt);
    const current = store.list('challenges', isOpen).sort(newestFirst)[0];
    return {
      status: 200,
      body: { challenge: current ? publicChallenge(current) : null },
    };
  });

  router.route('GET', '/v1/challenges/:challengeId/entries', async ({ req, params }) => {
    const user = ctx.optionalUser(req);
    const challenge = store.get('challenges', params.challengeId);
    if (!challenge) throw new HttpError(404, 'not_found');

    // Most liked first; ties go to the newer entry.
    const designs = entriesOf(challenge)
      .sort((a, b) => b.likeCount - a.likeCount || b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_ENTRIES_SHOWN);

    return {
      status: 200,
      body: {
        challenge: publicChallenge(challenge),
        designs: designs.map((d) => publicDesign(d, user?.id)),
      },
    };
  });

  // Admin: only exists when DESIGNWEAR_ADMIN_TOKEN is set.
  router.route('PUT', '/v1/admin/challenges/:challengeId', async ({ req, params }) => {
    if (!config.adminToken) throw new HttpError(404, 'not_found');
    ctx.limit(`admin:${ctx.ipOf(req)}`, 30, 60_000);

    const given = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!safeEqual(given, config.adminToken)) {
      throw new HttpError(401, 'unauthenticated', 'Admin token required.');
    }
    if (!/^[a-z0-9-]{2,40}$/.test(params.challengeId)) {
      throw bad('invalid_id', 'Use lowercase letters, numbers and dashes.');
    }

    const challenge = {
      id: params.challengeId,
      ...v.challengeInput(await ctx.readBody(req)),
    };
    await store.put('challenges', challenge.id, challenge);

    return { status: 200, body: { challenge: publicChallenge(challenge) } };
  });
}
