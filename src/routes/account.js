// The signed-in user's profile, password, and saved addresses.
import { newId, publicUser } from '../context.js';
import { hashPassword, verifyPassword } from '../security.js';
import * as v from '../validate.js';
import { HttpError, bad } from '../validate.js';

const MAX_ADDRESSES = 20;

export function registerAccountRoutes(router, ctx) {
  const { store } = ctx;

  router.route('GET', '/v1/me', async ({ req }) => ({
    status: 200,
    body: { user: publicUser(ctx.authed(req)) },
  }));

  router.route('PATCH', '/v1/me', async ({ req }) => {
    const user = ctx.authed(req);
    const body = await ctx.readBody(req);

    if (body.name !== undefined) {
      user.name = v.str(body.name, 'name', { max: 80 });
    }
    if (body.phone !== undefined) {
      user.phone = v.str(String(body.phone), 'phone', { min: 0, max: 20 });
    }
    await store.put('users', user.id, user);

    return { status: 200, body: { user: publicUser(user) } };
  });

  router.route('POST', '/v1/me/password', async ({ req }) => {
    const user = ctx.authed(req);
    const body = await ctx.readBody(req);

    const currentOk = await verifyPassword(String(body.current ?? ''), user.pw);
    if (!currentOk) {
      throw new HttpError(403, 'invalid_credentials', 'Current password is incorrect.');
    }

    user.pw = await hashPassword(v.password(body.password));
    user.tokenVersion += 1; // signs out other sessions; this one gets a new token
    await store.put('users', user.id, user);

    return { status: 200, body: ctx.issue(user) };
  });

  router.route('GET', '/v1/me/addresses', async ({ req }) => {
    const user = ctx.authed(req);
    const saved = store.get('addresses', user.id);
    return { status: 200, body: { addresses: saved?.items ?? [] } };
  });

  router.route('PUT', '/v1/me/addresses', async ({ req }) => {
    const user = ctx.authed(req);
    const list = (await ctx.readBody(req)).addresses;

    if (!Array.isArray(list) || list.length > MAX_ADDRESSES) {
      throw bad('invalid_address', `At most ${MAX_ADDRESSES} addresses.`);
    }

    const items = list.map((raw) => {
      const address = v.address(raw);
      return { ...address, id: address.id ?? newId('a_') };
    });
    await store.put('addresses', user.id, { id: user.id, items });

    return { status: 200, body: { addresses: items } };
  });
}
