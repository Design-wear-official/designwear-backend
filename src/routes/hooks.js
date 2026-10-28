// SethuCMS tells us the moment someone changes an order there, so the customer is
// notified straight away instead of whenever they next open the app.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { HttpError } from '../validate.js';

const TOLERANCE_SECONDS = 300;

// The X-Sethu-Signature check from SethuCMS's docs: "t=<unix>,v1=<hex HMAC>".
export function verifySignature(rawBody, header, secret, nowMs = Date.now()) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((p) => p.split('=')));
  if (!parts.t || Math.abs(nowMs / 1000 - Number(parts.t)) > TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const given = Buffer.from(parts.v1 ?? '');
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export function registerHookRoutes(router, ctx) {
  const { config, store, now } = ctx;

  router.route('POST', '/v1/hooks/sethucms', async ({ req }) => {
    if (!config.webhookSecret) throw new HttpError(404, 'not_found');
    ctx.limit(`hook:${ctx.ipOf(req)}`, 300, 60_000);

    const raw = await ctx.readRaw(req, 64_000);
    if (!verifySignature(raw, req.headers['x-sethu-signature'], config.webhookSecret, now())) {
      throw new HttpError(401, 'bad_signature');
    }

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'invalid_json');
    }

    // Only order records matter; anything else is acknowledged and ignored.
    const isOrderChange =
      event.collection === (config.ordersSync.collection ?? 'orders') &&
      ['record.updated', 'record.created'].includes(event.type) &&
      typeof event.recordId === 'string';
    if (isOrderChange) {
      const order = await store.get('orders', event.recordId);
      if (order) await ctx.refreshOrder(order);
    }
    return { status: 200, body: { ok: true } };
  });
}
