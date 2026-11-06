// The people who run orders: vendors (local teams), the order desk, delivery
// partners and the owner. They sign in like anyone else (POST /v1/auth/login);
// the owner marks an account as staff with PUT /v1/admin/staff. Every status
// change goes through here, so the lifecycle rules and each person's scope are
// enforced by the API instead of by whichever screen they happen to use.
import { newId } from '../context.js';
import { STATUSES, canRoleMove, isFinal } from '../lifecycle.js';
import * as v from '../validate.js';
import { HttpError, bad } from '../validate.js';

export const STAFF_ROLES = ['vendor', 'desk', 'delivery', 'owner'];
const ASSIGNABLE = ['awaiting_payment', 'placed', 'confirmed'];
const HOUR = 3600_000;
// How long an order may sit in a status before the owner is told it is stuck.
const STUCK_AFTER_HOURS = { placed: 24, confirmed: 48, packed: 48, shipped: 120 };

/** Whether this staff member may see (and act on) the order. */
export function visibleTo(staff, order) {
  switch (staff.role) {
    case 'owner':
    case 'desk':
      return true;
    case 'vendor':
      return Boolean(staff.teamId) && order.team?.id === staff.teamId;
    case 'delivery':
      return ['packed', 'shipped', 'delivered'].includes(order.status);
    default:
      return false;
  }
}

export function registerStaffRoutes(router, ctx) {
  const { store, catalog, now } = ctx;

  // Owner: make an existing account staff (or remove it with role: null).
  router.route('PUT', '/v1/admin/staff', async ({ req }) => {
    ctx.requireAdmin(req);
    const body = await ctx.readBody(req);
    const email = v.email(body.email);
    let user = await ctx.findUserByEmail(email);
    if (!user && body.role === null) throw new HttpError(404, 'not_found', 'No account with that email.');
    if (!user) {
      // Staff may be named before they ever open the app; they sign in with SethuCMS or Google.
      user = {
        id: newId('u_'),
        email,
        name: body.name ? v.str(body.name, 'name', { max: 80 }) : email.split('@')[0],
        phone: '',
        pw: null,
        tokenVersion: 1,
        createdAt: new Date(now()).toISOString(),
      };
      await store.put('users', user.id, user);
      await ctx.indexUser(user);
    }

    if (body.role === null) {
      delete user.staff;
    } else {
      if (!STAFF_ROLES.includes(body.role)) throw bad('invalid_role', `Role must be one of ${STAFF_ROLES.join(', ')}.`);
      const teamId = body.teamId ? v.str(body.teamId, 'teamId', { max: 80 }) : '';
      if (body.role === 'vendor' && !teamId) throw bad('team_required', 'A vendor belongs to a team (teamId).');
      user.staff = { role: body.role, ...(teamId && { teamId }) };
    }
    await store.put('users', user.id, user);
    await ctx.audit('admin', 'staff.set', user.id, { staff: user.staff ?? null });
    return { status: 200, body: { id: user.id, email: user.email, staff: user.staff ?? null } };
  });

  router.route('GET', '/v1/staff/me', async ({ req }) => {
    const staff = await ctx.staffUser(req);
    return { status: 200, body: { staff: { id: staff.id, name: staff.name, role: staff.role, teamId: staff.teamId ?? null } } };
  });

  router.route('GET', '/v1/staff/orders', async ({ req, query }) => {
    const staff = await ctx.staffUser(req);
    const wanted = query.get('status');
    if (wanted && !STATUSES.includes(wanted)) throw bad('invalid_status', 'Unknown status.');
    const limit = Math.min(Math.max(Number(query.get('limit')) || 100, 1), 200);

    const orders = (await store.list('orders', (o) => visibleTo(staff, o) && (!wanted || o.status === wanted)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    return { status: 200, body: { orders } };
  });

  router.route('POST', '/v1/staff/orders/:orderId/status', async ({ req, params }) => {
    const staff = await ctx.staffUser(req);
    ctx.limit(`staff:${staff.id}`, 300, 60_000);
    const body = await ctx.readBody(req);
    if (!STATUSES.includes(body.status)) throw bad('invalid_status', 'Unknown status.');

    const order = await store.get('orders', params.orderId);
    if (!order || !visibleTo(staff, order)) throw new HttpError(404, 'not_found');
    if (!canRoleMove(staff.role, order.status, body.status)) {
      throw new HttpError(409, 'not_allowed', `A ${staff.role} cannot move an order from ${order.status} to ${body.status}.`);
    }

    if (body.status === 'shipped') {
      order.tracking = {
        id: v.str(body.trackingId, 'trackingId', { max: 80 }),
        carrier: body.carrier ? v.str(body.carrier, 'carrier', { max: 80 }) : '',
      };
    }
    if (body.status === 'delivered' && order.payment?.method === 'cod') {
      order.payment = { ...order.payment, status: 'collected' };
    }
    if (body.status === 'cancelled') {
      for (const line of order.lines) {
        const job = line.printJobId && (await store.get('printjobs', line.printJobId));
        if (job) await store.put('printjobs', job.id, { ...job, status: 'cancelled' });
      }
    }

    const from = order.status;
    order.status = body.status;
    order.history = [
      ...(order.history ?? []),
      {
        status: body.status,
        at: new Date(now()).toISOString(),
        by: staff.id,
        role: staff.role,
        ...(body.note && { note: v.str(body.note, 'note', { max: 200 }) }),
      },
    ];
    await store.put('orders', order.id, order);
    await ctx.syncOrder(order);
    await ctx.audit(staff.id, 'order.status', order.id, { from, to: body.status, role: staff.role });
    await ctx.notifyOrder(order, body.status);
    return { status: 200, body: { order } };
  });

  // Desk or owner: choose which team makes the order (before it is packed).
  router.route('POST', '/v1/staff/orders/:orderId/assign', async ({ req, params }) => {
    const staff = await ctx.staffUser(req, ['desk', 'owner']);
    const body = await ctx.readBody(req);
    const order = await store.get('orders', params.orderId);
    if (!order) throw new HttpError(404, 'not_found');
    if (!ASSIGNABLE.includes(order.status)) {
      throw new HttpError(409, 'not_assignable', 'This order is already being made.');
    }
    const teams = (await catalog.teams?.()) ?? [];
    const team = teams.find((t) => t.id === body.teamId);
    if (!team) throw bad('unknown_team', 'No such team.');

    order.team = { id: team.id, name: team.name, phone: team.phone };
    order.history = [...(order.history ?? []), { status: order.status, at: new Date(now()).toISOString(), by: staff.id, role: staff.role, note: `Assigned to ${team.name}` }];
    await store.put('orders', order.id, order);
    await ctx.syncOrder(order);
    await ctx.audit(staff.id, 'order.assign', order.id, { teamId: team.id });
    return { status: 200, body: { order } };
  });

  // Desk or owner: the numbers on one screen.
  router.route('GET', '/v1/staff/summary', async ({ req }) => {
    await ctx.staffUser(req, ['desk', 'owner']);
    // The SethuCMS count runs beside the local scan, so it adds no time of its own.
    const [orders, cmsCount] = await Promise.all([store.list('orders'), ctx.cmsOrderCount()]);
    const nowMs = now();
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    const byTeam = {};
    let sales = 0;
    let cashToCollect = 0;
    const stuck = [];

    for (const o of orders) {
      byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      if (o.status === 'cancelled') continue;
      sales += o.total;
      const team = (byTeam[o.team?.id ?? 'unassigned'] ??= { name: o.team?.name ?? 'Unassigned', orders: 0, sales: 0 });
      team.orders += 1;
      team.sales += o.total;
      if (o.payment?.method === 'cod' && !isFinal(o.status)) cashToCollect += o.total;
      const limit = STUCK_AFTER_HOURS[o.status];
      const since = Date.parse(o.history?.at(-1)?.at ?? o.createdAt);
      if (limit && nowMs - since > limit * HOUR) stuck.push({ id: o.id, status: o.status, hours: Math.floor((nowMs - since) / HOUR) });
    }
    // What SethuCMS holds, so the owner can spot orders that never reached the mirror. When the count was
    // cut off at its limit it cannot be compared, so inSync is null rather than a false alarm.
    const cms = cmsCount && { orders: cmsCount.count, exact: cmsCount.exact, inSync: cmsCount.exact ? cmsCount.count === orders.length : null };
    return { status: 200, body: { byStatus, byTeam, sales: v.round2(sales), cashToCollect: v.round2(cashToCollect), stuck, cms: cms ?? null } };
  });
}
