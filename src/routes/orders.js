// Placing, listing, and cancelling orders.
import { randomBytes } from 'node:crypto';

import { createFulfilment } from '../fulfilment.js';
import { createPricing } from '../pricing.js';
import * as v from '../validate.js';
import { HttpError, bad } from '../validate.js';

const CANCELLABLE = ['placed', 'awaiting_payment'];

export function registerOrderRoutes(router, ctx) {
  const { config, store, now } = ctx;
  const pricing = createPricing(ctx);
  const fulfilment = createFulfilment(ctx);

  router.route('POST', '/v1/orders', async ({ req }) => {
    const user = await ctx.authed(req);
    ctx.limit(`order:${user.id}`, 20, 3600_000);
    const body = await ctx.readBody(req);

    const address = v.address(body.address);
    const { team, priced: pricedWithDesigns } = await fulfilment.assign({
      pin: address.pin,
      price: (options) => pricing.priceLines(user.id, body.lines, options),
    });
    const { printDesigns, ...priced } = pricedWithDesigns;
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
      address,
      team: team && { id: team.id, name: team.name, phone: team.phone },
      payment: {
        method,
        status: cashOnDelivery ? 'pay_on_delivery' : 'pending',
      },
      status: cashOnDelivery ? 'placed' : 'awaiting_payment',
    };
    order.history = [{ status: order.status, at: order.createdAt }];

    // Each custom design becomes a print job holding its own copy of the artwork,
    // so editing or deleting the design later never changes what gets printed.
    // Kept apart from the order because the artwork can be large.
    for (const [index, design] of printDesigns) {
      const line = order.lines[index];
      line.printJobId = `${order.id}-${index + 1}`;
      await store.put('printjobs', line.printJobId, {
        id: line.printJobId,
        orderId: order.id,
        userId: user.id,
        status: 'queued',
        size: line.size,
        quantity: line.quantity,
        createdAt: order.createdAt,
        design: {
          id: design.id,
          name: design.name,
          garment: design.garment,
          baseColor: design.baseColor,
          front: design.front,
          back: design.back,
          designJson: design.designJson ?? null,
          previewImage: design.previewImage ?? null,
          backPreviewImage: design.backPreviewImage ?? null,
        },
      });
    }
    await store.put('orders', order.id, order);

    // Online orders keep the cart until the payment is verified.
    if (cashOnDelivery) {
      await store.put('carts', user.id, { id: user.id, lines: [] });
    }
    await ctx.syncOrder(order);
    await ctx.audit(user.id, 'order.created', order.id, { total: order.total, method });
    // Online orders are announced once the payment goes through.
    if (cashOnDelivery) await ctx.notifyOrder(order, 'placed');
    return { status: 201, body: { order } };
  });

  router.route('GET', '/v1/orders', async ({ req }) => {
    const user = await ctx.authed(req);
    const mine = await store.list('orders', (o) => o.userId === user.id);
    // Orders still moving may have been updated by the business in SethuCMS.
    const recent = mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const orders = await Promise.all(recent.map((o, i) => (i < 10 ? ctx.refreshOrder(o) : o)));
    return { status: 200, body: { orders } };
  });

  // The receipt again, to the address on the account. Only for orders that were placed.
  router.route('POST', '/v1/orders/:orderId/receipt', async ({ req, params }) => {
    const user = await ctx.authed(req);
    ctx.limit(`receipt:${user.id}`, 5, 3600_000);
    const order = await store.get('orders', params.orderId);
    if (!order || order.userId !== user.id) throw new HttpError(404, 'not_found');
    if (order.status === 'awaiting_payment') {
      throw new HttpError(409, 'not_placed', 'This order has not been placed yet.');
    }
    const result = await ctx.resendReceipt(order);
    return { status: result.sent ? 200 : 502, body: result.sent ? { sent: true } : { error: { code: 'mail_failed', message: 'The receipt could not be sent. Try again later.' } } };
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

    for (const line of order.lines) {
      const job = line.printJobId && (await store.get('printjobs', line.printJobId));
      if (job) await store.put('printjobs', job.id, { ...job, status: 'cancelled' });
    }
    order.status = 'cancelled';
    order.history = [...(order.history ?? []), { status: 'cancelled', at: new Date(now()).toISOString(), note: 'Cancelled by customer' }];
    await store.put('orders', order.id, order);
    await ctx.syncOrder(order);
    await ctx.audit(user.id, 'order.cancelled', order.id, { by: 'customer' });
    await ctx.notifyOrder(order, 'cancelled');
    return { status: 200, body: { order } };
  });
}
