// What DesignWear owes each vendor team. A delivered order earns the team its
// subtotal minus DesignWear's commission; a refunded return of an order that was
// already paid out is taken off the next payout. The owner settles a team, which
// writes one payout record and marks everything it covered, so nothing is paid twice.
import { newId } from '../context.js';
import * as v from '../validate.js';
import { HttpError, bad } from '../validate.js';

export async function pendingPayout(store, teamId, commissionPct) {
  const orders = await store.list('orders', (o) => o.team?.id === teamId && o.status === 'delivered');
  const returns = await store.list('returns', (r) => r.teamId === teamId && r.status === 'refunded');
  const refunded = new Set(returns.map((r) => r.orderId));

  const earning = orders.filter((o) => !o.payoutId && !refunded.has(o.id));
  const clawbacks = returns.filter((r) => !r.deductedIn && orders.some((o) => o.id === r.orderId && o.payoutId));
  const share = (o) => v.round2(o.subtotal * (1 - commissionPct / 100));

  const earnings = v.round2(earning.reduce((sum, o) => sum + share(o), 0));
  const deductions = v.round2(clawbacks.reduce((sum, r) => sum + share(orders.find((o) => o.id === r.orderId)), 0));
  return { teamId, commissionPct, orders: earning, returns: clawbacks, earnings, deductions, payable: v.round2(earnings - deductions) };
}

export function registerPayoutRoutes(router, ctx) {
  const { config, store, catalog, now } = ctx;
  const brief = (p) => ({
    teamId: p.teamId, orders: p.orders.length, earnings: p.earnings, deductions: p.deductions, payable: p.payable,
  });

  router.route('GET', '/v1/staff/payouts', async ({ req, query }) => {
    const staff = await ctx.staffUser(req, ['vendor', 'desk', 'owner']);
    const scope = staff.role === 'vendor' ? staff.teamId : query.get('teamId');
    const teamIds = scope
      ? [scope]
      : ((await catalog.teams?.()) ?? []).map((t) => t.id);
    const pending = [];
    for (const id of teamIds) pending.push(brief(await pendingPayout(store, id, config.commissionPct)));
    const history = (await store.list('payouts', (p) => !scope || p.teamId === scope))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { status: 200, body: { commissionPct: config.commissionPct, pending, history } };
  });

  router.route('POST', '/v1/staff/payouts', async ({ req }) => {
    const staff = await ctx.staffUser(req, ['owner']);
    const body = await ctx.readBody(req);
    const teamId = v.str(body.teamId, 'teamId', { max: 80 });
    const pending = await pendingPayout(store, teamId, config.commissionPct);
    if (pending.payable <= 0) throw new HttpError(409, 'nothing_to_settle', 'There is nothing to pay this team.');

    const payout = {
      id: newId('P'),
      teamId,
      amount: pending.payable,
      earnings: pending.earnings,
      deductions: pending.deductions,
      commissionPct: pending.commissionPct,
      orderIds: pending.orders.map((o) => o.id),
      returnIds: pending.returns.map((r) => r.id),
      reference: body.reference ? v.str(body.reference, 'reference', { max: 120 }) : '',
      createdAt: new Date(now()).toISOString(),
      by: staff.id,
    };
    await store.put('payouts', payout.id, payout);
    for (const o of pending.orders) await store.put('orders', o.id, { ...o, payoutId: payout.id });
    for (const r of pending.returns) await store.put('returns', r.id, { ...r, deductedIn: payout.id });
    await ctx.audit(staff.id, 'payout.settled', payout.id, { teamId, amount: payout.amount });
    return { status: 201, body: { payout } };
  });
}
