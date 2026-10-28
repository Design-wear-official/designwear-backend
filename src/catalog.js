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
    remix:
      Boolean(r.remixedFromHandle || r.remixedFromVersion) ||
      /^\s*remix by\b/i.test(String(r.title ?? '')),
  };
}

/** What the shop sells: originals with a price. Remix records stay in the database untouched. */
export const isSellable = (p) => !p.remix && Number.isFinite(p.price) && p.price > 0;

/**
 * A local team: has the T-shirts, serves some PIN codes, and delivers there.
 * SethuCMS collection `teams`: id, name, phone, pins (list or comma-separated text),
 * active (defaults to true).
 */
export function normaliseTeam(r) {
  const pins = Array.isArray(r.pins) ? r.pins : String(r.pins ?? '').split(/[\s,]+/);
  return {
    id: String(r.id ?? r._id ?? ''),
    name: String(r.name ?? r.title ?? ''),
    phone: String(r.phone ?? ''),
    pins: pins.map((p) => String(p).trim()).filter((p) => /^\d{6}$/.test(p)),
    active: r.active !== false,
  };
}

export class CmsCatalog {
  constructor({ url, connectionId, token }, fetchImpl = fetch, ttlMs = 60_000) {
    Object.assign(this, { url, connectionId, token, fetchImpl, ttlMs });
    this.caches = new Map(); // collection -> { at, items }
    this.inflight = new Map();
  }

  get configured() {
    return Boolean(this.url && this.connectionId && this.token);
  }

  async products() {
    const records = await this.#collection('products');
    return records.map(normaliseProduct).filter((p) => p.id && isSellable(p));
  }

  async product(id) {
    return (await this.products()).find((p) => p.id === id) ?? null;
  }

  /** Active local teams. Empty when the `teams` collection is missing or unused. */
  async teams() {
    const records = await this.#collection('teams', { optional: true });
    return records.map(normaliseTeam).filter((t) => t.id && t.active);
  }

  /**
   * Units of a product a team has, from SethuCMS collection `team_stock`
   * (teamId, productId, quantity). A missing row means none.
   */
  async teamStock(teamId, productId) {
    const rows = await this.#collection('team_stock', { optional: true });
    const row = rows.find((r) => String(r.teamId) === teamId && String(r.productId) === productId);
    return Math.max(0, Number(row?.quantity ?? 0) || 0);
  }

  // Raw records of one collection, cached briefly. One refresh at a time:
  // concurrent requests on a cold cache share it instead of each paging.
  async #collection(name, { optional = false } = {}) {
    if (!this.configured) return [];
    const cached = this.caches.get(name);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.items;
    if (!this.inflight.has(name)) {
      const refresh = this.#refresh(name, optional).finally(() => this.inflight.delete(name));
      this.inflight.set(name, refresh);
    }
    return this.inflight.get(name);
  }

  async #refresh(name, optional) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ limit: '100' });
      if (cursor) q.set('cursor', cursor);
      const connection = encodeURIComponent(this.connectionId);
      const res = await this.fetchImpl(
        `${this.url}/v1/connections/${connection}/collections/${encodeURIComponent(name)}/records?${q}`,
        { headers: { authorization: `Bearer ${this.token}` }, redirect: 'error' },
      );
      // A collection that is not set up yet simply has no records.
      if (optional && (res.status === 404 || res.status === 403)) break;
      if (!res.ok) throw new Error(`catalog_unavailable:${res.status}`);
      const body = await res.json();
      items.push(...body.data);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    this.caches.set(name, { at: Date.now(), items });
    return items;
  }
}
