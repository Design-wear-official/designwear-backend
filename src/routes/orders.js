// Placing, listing, and cancelling orders.
import { randomBytes } from 'node:crypto';

import { createPricing } from '../pricing.js';
import * as v from '../validate.js';
import { HttpError, bad } from '../validate.js';

const CANCELLABLE = ['placed', 'awaiting_payment'];

export function registerOrderRoutes(router, ctx) {
  const { config, store, now } = ctx;
  const pricing = createPricing(ctx);

  router.route('POST', '/v1/orders', async ({ req }) => {
    const user = await ctx.authed(req);
    ctx.limit(`order:${user.id}`, 20, 3600_000);
    const body = await ctx.readBody(req);

    const priced = await pricing.priceLines(user.id, body.lines);
    const method = body.paymentMethod === 'razorpay' ? 'razorpay' : 'cod';
    const cashOnDelivery = method === 'cod';

    const { keyId, keySecret } = config.razorpay;
    if (!cashOnDelivery && !(keyId && keySecret)) {
      throw bad('payments_unavailable', 'Online payments are not enabled.');
    }

    const order = {
      id: 'DW' + randomBytes(5).toString('hex').toUpperCase(),
      userId: user.id,
      createdAt: new Date(now()).toISOString(),
      ...priced,
      address: v.address(body.address),
      payment: {
        method,
        status: cashOnDelivery ? 'pay_on_delivery' : 'pending',
      },
      status: cashOnDelivery ? 'placed' : 'awaiting_payment',
    };
    order.history = [{ status: order.status, at: order.createdAt }];
    await store.put('orders', order.id, order);

    // Online orders keep the cart until the payment is verified.
    if (cashOnDelivery) {
      await store.put('carts', user.id, { id: user.id, lines: [] });
    }
    return { status: 201, body: { order } };
  });

  router.route('GET', '/v1/orders', async ({ req }) => {
    const user = await ctx.authed(req);
    const mine = await store.list('orders', (o) => o.userId === user.id);
    const orders = mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { status: 200, body: { orders } };
  });

  router.route('POST', '/v1/orders/:orderId/cancel', async ({ req, params }) => {
    const user = await ctx.authed(req);
    const order = await store.get('orders', params.orderId);

    if (!order || order.userId !== user.id) {
      throw new HttpError(404, 'not_found');
    }
    if (!CANCELLABLE.includes(order.status)) {
      throw new HttpError(409, 'not_cancellable', 'This order can no longer be cancelled.');
    }

    order.status = 'cancelled';
    order.history = [...(order.history ?? []), { status: 'cancelled', at: new Date(now()).toISOString(), note: 'Cancelled by customer' }];
    await store.put('orders', order.id, order);
    return { status: 200, body: { order } };
  });
}
