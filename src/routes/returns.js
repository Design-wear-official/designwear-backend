// Returns and refunds. The customer asks within the return window after delivery;
// the desk or owner approves or rejects; the owner pays the refund back (through
// Razorpay for online payments, recorded by hand for cash on delivery).
import { newId } from '../context.js';
import * as v from '../validate.js';
import { HttpError, bad } from '../validate.js';

const DAY = 86_400_000;
const RAZORPAY_PAYMENTS_URL = 'https://api.razorpay.com/v1/payments';

export function registerReturnRoutes(router, ctx) {
  const { config, store, now } = ctx;
  const stamp = () => new Date(now()).toISOString();

  router.route('POST', '/v1/orders/:orderId/return', async ({ req, params }) => {
    const user = await ctx.authed(req);
    ctx.limit(`return:${user.id}`, 10, 3600_000);
    const body = await ctx.readBody(req);
    const reason = v.str(body.reason, 'reason', { min: 3, max: 500 });

    const order = await store.get('orders', params.orderId);
    if (!order || order.userId !== user.id) throw new HttpError(404, 'not_found');
    const deliveredAt = order.status === 'delivered' && order.history?.findLast((h) => h.status === 'delivered')?.at;
    if (!deliveredAt) throw new HttpError(409, 'not_delivered', 'Only delivered orders can be returned.');
    if (now() - Date.parse(deliveredAt) > config.returnWindowDays * DAY) {
      throw new HttpError(409, 'window_closed', `Returns are accepted for ${config.returnWindowDays} days after delivery.`);
    }
    if ((await store.list('returns', (r) => r.orderId === order.id && r.status !== 'rejected')).length) {
      throw new HttpError(409, 'already_requested', 'A return was already requested for this order.');
    }

    const ret = {
      id: newId('R'),
      orderId: order.id,
      userId: user.id,
      teamId: order.team?.id ?? '',
      reason,
      amount: order.total,
      status: 'requested',
      createdAt: stamp(),
      history: [{ status: 'requested', at: stamp() }],
    };
    await store.put('returns', ret.id, ret);
    await ctx.audit(user.id, 'return.requested', order.id, { returnId: ret.id });
    return { status: 201, body: { return: ret } };
  });

  router.route('GET', '/v1/returns', async ({ req }) => {
    const user = await ctx.authed(req);
    const mine = await store.list('returns', (r) => r.userId === user.id);
    return { status: 200, body: { returns: mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) } };
  });

  router.route('GET', '/v1/staff/returns', async ({ req, query }) => {
    const staff = await ctx.staffUser(req, ['vendor', 'desk', 'owner']);
    const wanted = query.get('status');
    const all = await store.list('returns', (r) => !wanted || r.status === wanted);
    const returns = staff.role === 'vendor' ? all.filter((r) => r.teamId && r.teamId === staff.teamId) : all;
    return { status: 200, body: { returns: returns.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) } };
  });

  async function loadReturn(id, status) {
    const ret = await store.get('returns', id);
    if (!ret) throw new HttpError(404, 'not_found');
    if (ret.status !== status) throw new HttpError(409, 'wrong_state', `This return is ${ret.status}, not ${status}.`);
    return ret;
  }
  const advance = (ret, status, staff, extra = {}) => {
    Object.assign(ret, extra, { status });
    ret.history = [...ret.history, { status, at: stamp(), by: staff.id, role: staff.role, ...(extra.note && { note: extra.note }) }];
    return store.put('returns', ret.id, ret);
  };

  router.route('POST', '/v1/staff/returns/:returnId/decision', async ({ req, params }) => {
    const staff = await ctx.staffUser(req, ['desk', 'owner']);
    const body = await ctx.readBody(req);
    if (!['approve', 'reject'].includes(body.decision)) throw bad('invalid_decision', 'decision must be approve or reject.');
    const ret = await loadReturn(params.returnId, 'requested');
    const note = body.note ? v.str(body.note, 'note', { max: 300 }) : undefined;
    await advance(ret, body.decision === 'approve' ? 'approved' : 'rejected', staff, { note });
    await ctx.audit(staff.id, `return.${ret.status}`, ret.orderId, { returnId: ret.id });
    return { status: 200, body: { return: ret } };
  });

  router.route('POST', '/v1/staff/returns/:returnId/refund', async ({ req, params }) => {
    const staff = await ctx.staffUser(req, ['owner']);
    const ret = await loadReturn(params.returnId, 'approved');
    const order = await store.get('orders', ret.orderId);
    if (!order) throw new HttpError(404, 'not_found');

    let refund = { method: 'manual' };
    const { keyId, keySecret } = config.razorpay;
    if (order.payment.method === 'razorpay' && order.payment.paymentId) {
      if (!(keyId && keySecret)) throw bad('payments_unavailable', 'Online refunds are not enabled.');
      const credentials = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
      const res = await (config.fetch ?? fetch)(`${RAZORPAY_PAYMENTS_URL}/${encodeURIComponent(order.payment.paymentId)}/refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Basic ${credentials}` },
        body: JSON.stringify({ amount: Math.round(ret.amount * 100), receipt: ret.id }),
      });
      if (!res.ok) throw new HttpError(502, 'payment_provider_error', 'The refund could not be made. Try again.');
      refund = { method: 'razorpay', id: (await res.json()).id };
    }

    await advance(ret, 'refunded', staff, { refund, refundedAt: stamp() });
    order.payment = { ...order.payment, status: 'refunded' };
    await store.put('orders', order.id, order);
    await ctx.syncOrder(order);
    await ctx.audit(staff.id, 'return.refunded', order.id, { returnId: ret.id, amount: ret.amount, method: refund.method });
    const user = await store.get('users', ret.userId);
    if (user) {
      await ctx.notifier.notify(user, {
        type: 'return.refunded',
        title: 'Refund issued',
        body: `Your refund of ₹${ret.amount} for order ${order.id} has been issued.`,
        orderId: order.id,
      });
    }
    return { status: 200, body: { return: ret } };
  });
}
