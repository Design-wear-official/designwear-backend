/** Reads products from the SethuCMS gateway so the server prices orders itself. */
function num(v) {
  return typeof v === 'number' ? v : Number.parseFloat(v);
}

export function normaliseProduct(r) {
  const price = num(r.price);
  return {
    raw: r,
    id: String(r.id ?? r._id ?? ''),
    title: String(r.title ?? r.name ?? ''),
    description: String(r.description ?? ''),
    price: Number.isFinite(price) ? price : NaN,
    imageUrl: r.previewImageUrl || r.imageUrl || null,
    stock: Number(r.stockCount ?? r.stock ?? 0) || 0,
    tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
    productType: r.productType ? String(r.productType) : '',
    remix: Boolean(r.remixedFromHandle || r.remixedFromVersion) || /^\s*remix by\b/i.test(String(r.title ?? '')),
  };
}

/** What the shop sells: originals with a price. Remix records stay in the database untouched. */
export const isSellable = (p) => !p.remix && Number.isFinite(p.price) && p.price > 0;

export class CmsCatalog {
  constructor({ url, connectionId, token }, fetchImpl = fetch, ttlMs = 60_000) {
    Object.assign(this, { url, connectionId, token, fetchImpl, ttlMs });
    this.cache = null;
  }

  get configured() {
    return Boolean(this.url && this.connectionId && this.token);
  }

  async products() {
    if (!this.configured) return [];
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.items;
    // One refresh at a time: concurrent requests on a cold or expired cache
    // share it instead of each paging through the whole catalog.
    this.inflight ??= this.#refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async #refresh() {
    const items = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ limit: '100' });
      if (cursor) q.set('cursor', cursor);
      const res = await this.fetchImpl(
        `${this.url}/v1/connections/${encodeURIComponent(this.connectionId)}/collections/products/records?${q}`,
        { headers: { authorization: `Bearer ${this.token}` }, redirect: 'error' },
      );
      if (!res.ok) throw new Error(`catalog_unavailable:${res.status}`);
      const body = await res.json();
      items.push(...body.data.map(normaliseProduct).filter((p) => p.id && isSellable(p)));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    this.cache = { at: Date.now(), items };
    return items;
  }

  async product(id) {
    return (await this.products()).find((p) => p.id === id) ?? null;
  }
}
