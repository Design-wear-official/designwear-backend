// Razorpay: create a payment for an order, then verify its signature.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { HttpError, bad } from '../validate.js';

const RAZORPAY_ORDERS_URL = 'https://api.razorpay.com/v1/orders';

export function registerPaymentRoutes(router, ctx) {
  const { config, store } = ctx;

  router.route('POST', '/v1/payments/razorpay/order', async ({ req }) => {
    const user = await ctx.authed(req);
    const { keyId, keySecret } = config.razorpay;
    if (!keyId || !keySecret) {
      throw bad('payments_unavailable', 'Online payments are not enabled.');
    }

    const body = await ctx.readBody(req);
    const order = await store.get('orders', String(body.orderId ?? ''));
    const payable = order && order.userId === user.id && order.status === 'awaiting_payment';
    if (!payable) throw new HttpError(404, 'not_found');

    const credentials = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const response = await (config.fetch ?? fetch)(RAZORPAY_ORDERS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({
        amount: Math.round(order.total * 100), // paise
        currency: 'INR',
        receipt: order.id,
      }),
    });
    if (!response.ok) {
      throw new HttpError(502, 'payment_provider_error', 'Could not start the payment.');
    }

    const razorpayOrder = await response.json();
    order.payment = { ...order.payment, razorpayOrderId: razorpayOrder.id };
    await store.put('orders', order.id, order);

    return {
      status: 200,
      body: {
        razorpayOrderId: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        keyId,
      },
    };
  });

  router.route('POST', '/v1/payments/razorpay/verify', async ({ req }) => {
    const user = await ctx.authed(req);
    const body = await ctx.readBody(req);

    const order = await store.get('orders', String(body.orderId ?? ''));
    const verifiable = order && order.userId === user.id && order.payment.razorpayOrderId;
    if (!verifiable) throw new HttpError(404, 'not_found');

    const paymentId = String(body.paymentId ?? '');
    const expected = createHmac('sha256', config.razorpay.keySecret)
      .update(`${order.payment.razorpayOrderId}|${paymentId}`)
      .digest('hex');
    const given = String(body.signature ?? '');

    const matches =
      given.length === expected.length &&
      timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!matches) {
      throw bad('invalid_signature', 'Payment could not be verified.');
    }

    order.payment = { ...order.payment, status: 'paid', paymentId: String(body.paymentId) };
    order.status = 'placed';
    await store.put('orders', order.id, order);
    await store.put('carts', user.id, { id: user.id, lines: [] });

    return { status: 200, body: { order } };
  });
}
