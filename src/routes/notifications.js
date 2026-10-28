// The customer's inbox, and the phones that should get push notifications.
import * as v from '../validate.js';

const PLATFORMS = ['android', 'ios', 'web'];

export function registerNotificationRoutes(router, ctx) {
  const { notifier } = ctx;

  router.route('GET', '/v1/notifications', async ({ req }) => {
    const user = await ctx.authed(req);
    return { status: 200, body: await notifier.list(user.id) };
  });

  router.route('POST', '/v1/notifications/read', async ({ req }) => {
    const user = await ctx.authed(req);
    await notifier.markAllRead(user.id);
    return { status: 200, body: { ok: true } };
  });

  // The app registers its Firebase messaging token after sign-in.
  router.route('POST', '/v1/me/devices', async ({ req }) => {
    const user = await ctx.authed(req);
    ctx.limit(`device:${user.id}`, 30, 3600_000);
    const body = await ctx.readBody(req);
    const token = v.str(body.token, 'token', { max: 4096 });
    const platform = PLATFORMS.includes(body.platform) ? body.platform : 'android';
    await notifier.addDevice(user.id, token, platform);
    return { status: 200, body: { ok: true } };
  });

  router.route('DELETE', '/v1/me/devices', async ({ req }) => {
    const user = await ctx.authed(req);
    const body = await ctx.readBody(req);
    await notifier.removeDevice(user.id, String(body.token ?? ''));
    return { status: 200, body: { ok: true } };
  });
}
