// Mirrors orders into a SethuCMS collection so the business can see and run them
// there (dashboards, status changes), and reads status changes made there back.
//
// The collection must have exactly these fields, because SethuCMS refuses
// unknown ones: id (key), createdAt, updatedAt, status, customerName,
// customerEmail, customerPhone, address, city, state, pin, items, itemCount,
// subtotal, tax, total, paymentMethod, paymentStatus, teamId, teamName,
// trackingId, carrier, printFiles.

const TIMEOUT_MS = 6000;

export const ORDER_STATUSES = [
  'awaiting_payment', 'placed', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled',
];
const FINAL = ['delivered', 'cancelled'];

// `linkFor(printJobId)` gives the print-sheet link for a custom line ('' when none).
export function orderRecord(order, customer, linkFor = () => '') {
  const items = order.lines
    .map((line) => `${line.title} (${line.size}) x${line.quantity}`)
    .join('; ');
  return {
    id: order.id,
    createdAt: order.createdAt,
    updatedAt: order.history?.at(-1)?.at ?? order.createdAt,
    status: order.status,
    customerName: customer?.name ?? '',
    customerEmail: customer?.email ?? '',
    customerPhone: order.address.phone,
    address: order.address.line1,
    city: order.address.city,
    state: order.address.state,
    pin: order.address.pin,
    items,
    itemCount: order.lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotal: order.subtotal,
    tax: order.tax,
    total: order.total,
    paymentMethod: order.payment.method,
    paymentStatus: order.payment.status,
    teamId: order.team?.id ?? '',
    teamName: order.team?.name ?? '',
    trackingId: order.tracking?.id ?? '',
    carrier: order.tracking?.carrier ?? '',
    // One line per custom design: what to print and where to open its print sheet.
    printFiles: order.lines
      .filter((line) => line.printJobId && linkFor(line.printJobId))
      .map((line) => `${line.title} (${line.size}) x${line.quantity}: ${linkFor(line.printJobId)}`)
      .join('\n'),
  };
}

export class NullOrderSync {
  get enabled() {
    return false;
  }
  async push() {}
  async pull() {
    return null;
  }
}

export class CmsOrderSync {
  constructor({ url, connectionId, token, collection = 'orders' }, fetchImpl = fetch) {
    Object.assign(this, { url, connectionId, token, collection, fetchImpl });
  }

  get enabled() {
    return Boolean(this.url && this.connectionId && this.token);
  }

  #base() {
    const connection = encodeURIComponent(this.connectionId);
    const collection = encodeURIComponent(this.collection);
    return `${this.url}/v1/connections/${connection}/collections/${collection}/records`;
  }

  #call(method, path, body, idempotencyKey) {
    return this.fetchImpl(`${this.#base()}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body && { 'content-type': 'application/json' }),
        ...(idempotencyKey && { 'idempotency-key': idempotencyKey }),
      },
      body: body && JSON.stringify(body),
    });
  }

  // Creates the record, or updates it when it already exists. Safe to repeat:
  // a retried write with the same key is not applied twice.
  async push(order, customer, linkFor) {
    if (!this.enabled) return;
    const record = orderRecord(order, customer, linkFor);
    const version = order.history?.length ?? 0;

    const { id, ...changes } = record;
    const update = await this.#call('PATCH', `/${encodeURIComponent(id)}`, changes, `upd:${id}:${version}`);
    if (update.ok) return;
    if (update.status !== 404) throw new Error(`order_sync_failed:${update.status}`);

    const create = await this.#call('POST', '', record, `new:${id}`);
    if (!create.ok) throw new Error(`order_sync_failed:${create.status}`);
  }

  // What the business has set on this order in SethuCMS, or null.
  async pull(order) {
    if (!this.enabled || FINAL.includes(order.status)) return null;
    const response = await this.#call('GET', `/${encodeURIComponent(order.id)}`);
    if (!response.ok) return null;
    const record = (await response.json()).data ?? {};
    if (!ORDER_STATUSES.includes(record.status) || record.status === 'awaiting_payment') return null;
    return {
      status: record.status,
      tracking: record.trackingId
        ? { id: String(record.trackingId), carrier: String(record.carrier ?? '') }
        : null,
    };
  }
}
