// The server never trusts a price from the client: every line is priced from
// the catalog or from the stored design.
import { garmentPrice } from './presenters.js';
import * as v from './validate.js';
import { bad } from './validate.js';

const TAX_RATE = 0.18;

export function createPricing({ store, catalog }) {
  // The design behind a cart line, if this user is allowed to buy it
  // (published designs, or their own drafts). Otherwise null.
  async function purchasableDesign(designId, userId) {
    const design = await store.get('designs', designId);
    if (!design) return null;
    if (!design.published && design.ownerId !== userId) return null;
    return design;
  }

  function designLine(line, design) {
    return {
      ...line,
      title: `${design.name} (${design.garment})`,
      unitPrice: garmentPrice(design.garment),
      imageUrl: null,
    };
  }

  // Validates and prices order lines; throws if anything is unavailable.
  async function priceLines(userId, inputLines) {
    const priced = [];
    const requested = new Map(); // productId -> units asked for so far

    for (const line of v.lines(inputLines)) {
      if (line.designId) {
        const design = await purchasableDesign(line.designId, userId);
        if (!design) {
          throw bad('unknown_design', 'A design in your cart is no longer available.');
        }
        priced.push(designLine(line, design));
        continue;
      }

      const product = await catalog.product(line.productId);
      if (!product || !Number.isFinite(product.price)) {
        throw bad('unknown_product', `Product ${line.productId} is not available.`);
      }
      if (product.stock <= 0) {
        throw bad('out_of_stock', `${product.title} is out of stock.`);
      }
      // Stock is per product, so sizes of the same product share it.
      const wanted = (requested.get(product.id) ?? 0) + line.quantity;
      requested.set(product.id, wanted);
      if (wanted > product.stock) {
        throw bad('insufficient_stock', `Only ${product.stock} of ${product.title} left.`);
      }
      priced.push({
        ...line,
        title: product.title,
        unitPrice: product.price,
        imageUrl: product.imageUrl,
      });
    }

    const subtotal = v.round2(
      priced.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0),
    );
    const tax = v.round2(subtotal * TAX_RATE);
    return { lines: priced, subtotal, tax, total: v.round2(subtotal + tax) };
  }

  return { purchasableDesign, designLine, priceLines };
}
