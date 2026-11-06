// Team stock: what each vendor team has in hand, per product. Vendors update their
// own team; the desk and owner can see and change any team. Writes go to SethuCMS
// `team_stock` (needs SETHUCMS_STOCK_TOKEN), because that is what orders are checked against.
import * as v from '../validate.js';
import { HttpError, bad } from '../validate.js';

export function registerStockRoutes(router, ctx) {
  const { config, catalog } = ctx;

  const teamFor = (staff, wanted) => {
    const teamId = staff.role === 'vendor' ? staff.teamId : wanted;
    if (!teamId) throw bad('team_required', 'Say which team (teamId).');
    return teamId;
  };

  router.route('GET', '/v1/staff/stock', async ({ req, query }) => {
    const staff = await ctx.staffUser(req, ['vendor', 'desk', 'owner']);
    const teamId = teamFor(staff, query.get('teamId'));
    const rows = (await catalog.stockOf?.(teamId)) ?? [];
    const names = new Map((await catalog.products()).map((p) => [p.id, p.title]));
    const stock = rows.map((r) => ({ ...r, title: names.get(r.productId) ?? r.productId, low: r.quantity < config.lowStockAt }));
    return { status: 200, body: { teamId, lowStockAt: config.lowStockAt, stock, writable: Boolean(config.stockToken) } };
  });

  router.route('PUT', '/v1/staff/stock', async ({ req }) => {
    const staff = await ctx.staffUser(req, ['vendor', 'desk', 'owner']);
    ctx.limit(`stock:${staff.id}`, 120, 60_000);
    const body = await ctx.readBody(req);
    const teamId = teamFor(staff, body.teamId);
    const productId = v.str(body.productId, 'productId', { max: 120 });
    const quantity = body.quantity;
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 100_000) throw bad('invalid_quantity', 'quantity must be a whole number of 0 or more.');
    if (!config.stockToken) throw new HttpError(501, 'stock_writes_disabled', 'Stock updates are not set up (SETHUCMS_STOCK_TOKEN).');
    if (!(await catalog.product(productId))) throw new HttpError(404, 'not_found', 'No such product.');

    try {
      await catalog.setTeamStock(teamId, productId, quantity, config.stockToken);
    } catch (error) {
      ctx.logger.error(`Stock write failed: ${error.message}`, error);
      throw new HttpError(502, 'stock_write_failed', 'Could not save the stock. Try again.');
    }
    await ctx.audit(staff.id, 'stock.set', teamId, { productId, quantity });
    return { status: 200, body: { teamId, productId, quantity, low: quantity < config.lowStockAt } };
  });
}
