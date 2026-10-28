// The signed-in user's saved cart.
import { createPricing } from '../pricing.js';
import * as v from '../validate.js';

export function registerCartRoutes(router, ctx) {
  const { store, catalog } = ctx;
  const pricing = createPricing(ctx);

  router.route('GET', '/v1/cart', async ({ req }) => {
    const user = ctx.authed(req);
    const cart = store.get('carts', user.id);
    return { status: 200, body: { lines: cart?.lines ?? [] } };
  });

  // Saving a cart is forgiving: lines that can't be priced right now are kept
  // (or dropped, for designs that vanished). Checkout is what enforces prices.
  router.route('PUT', '/v1/cart', async ({ req }) => {
    const user = ctx.authed(req);
    const rawLines = (await ctx.readBody(req)).lines ?? [];
    const cleanLines = rawLines.length ? v.lines(rawLines) : [];
    const lines = [];

    for (const line of cleanLines) {
      if (line.designId) {
        const design = pricing.purchasableDesign(line.designId, user.id);
        if (design) lines.push(pricing.designLine(line, design));
        continue; // a design that is no longer available is dropped
      }

      const product = await catalog.product(line.productId).catch(() => null);
      lines.push({
        ...line,
        title: product?.title ?? line.productId,
        unitPrice: product?.price ?? 0,
        imageUrl: product?.imageUrl ?? null,
      });
    }

    await store.put('carts', user.id, { id: user.id, lines });
    return { status: 200, body: { lines } };
  });
}
