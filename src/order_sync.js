// Mirrors orders into a SethuCMS collection so the business can see and run them
// there (dashboards, status changes), and reads status changes made there back.
//
// The collection must have exactly these fields, because SethuCMS refuses
// unknown ones: id (key), createdAt, updatedAt, status, customerName,
// customerEmail, customerPhone, address, city, state, pin, items, itemCount,
// subtotal, tax, total, paymentMethod, paymentStatus, teamId, teamName,
// trackingId, carrier, printFiles.

import { failureOf, hasStatus, sethuClient } from './sethu.js';

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
  async count() {
    return null;
  }
}

export class CmsOrderSync {
  constructor({ url, connectionId, token, collection = 'orders', allowHttp = false }, fetchImpl = fetch) {
    Object.assign(this, { url, connectionId, token, collection, allowHttp, fetchImpl });
  }

  // Built on first use: with no address or token (sync off) there is nothing to give the SDK.
  get orders() {
    // Customers wait on these calls (their order list reads each order), so: 6 s and no retries,
    // as before the SDK. A slow gateway then costs a few seconds, not half a minute.
    this._orders ??= sethuClient({
      url: this.url, token: this.token, fetchImpl: this.fetchImpl, allowHttp: this.allowHttp,
      timeoutMs: 6000, maxRetries: 0,
    }).collection(this.connectionId, this.collection);
    return this._orders;
  }

  get enabled() {
    return Boolean(this.url && this.connectionId && this.token);
  }

  // Creates the record, or updates it when it already exists. Safe to repeat:
  // a retried write with the same key is not applied twice.
  async push(order, customer, linkFor) {
    if (!this.enabled) return;
    const record = orderRecord(order, customer, linkFor);
    const version = order.history?.length ?? 0;

    const { id, ...changes } = record;
    try {
      await this.orders.update(id, changes, { idempotencyKey: `upd:${id}:${version}` });
      return;
    } catch (error) {
      if (!hasStatus(error, 404)) throw new Error(`order_sync_failed:${failureOf(error)}`);
    }
    try {
      await this.orders.create(record, { idempotencyKey: `new:${id}` });
    } catch (error) {
      throw new Error(`order_sync_failed:${failureOf(error)}`);
    }
  }

  // What the business has set on this order in SethuCMS, or null.
  async pull(order) {
    if (!this.enabled || FINAL.includes(order.status)) return null;
    let record;
    try {
      record = await this.orders.get(order.id);
    } catch {
      return null;
    }
    if (!ORDER_STATUSES.includes(record.status) || record.status === 'awaiting_payment') return null;
    return {
      status: record.status,
      tracking: record.trackingId
        ? { id: String(record.trackingId), carrier: String(record.carrier ?? '') }
        : null,
    };
  }

  /** How many orders SethuCMS holds ({ count, exact }), or null when it cannot say. Counts up to 10,000. */
  async count() {
    if (!this.enabled) return null;
    try {
      return await this.orders.count({ max: 10_000 });
    } catch {
      return null;
    }
  }
}
