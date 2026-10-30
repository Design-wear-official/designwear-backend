// The receipt a customer gets by email once an order is placed or paid.
// Every value from the customer or the catalog is escaped before it enters the HTML.

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const rupees = (amount) =>
  `Rs ${Number(amount ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dateOf = (iso) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

function paymentLabel(payment = {}) {
  if (payment.status === 'paid') {
    return `Paid online${payment.paymentId ? ` (payment ${payment.paymentId})` : ''}`;
  }
  if (payment.method === 'cod' || payment.status === 'pay_on_delivery') return 'Pay on delivery';
  return 'Payment pending';
}

/** Receipt (and invoice) number: stable for an order so a resend never changes it. */
export function invoiceNumber(order) {
  return `INV-${order.id}`;
}

/** { subject, text, html } for one order. `supportEmail` is shown at the bottom. */
export function receiptEmail(order, { supportEmail = '' } = {}) {
  const lines = order.lines ?? [];
  const address = order.address ?? {};
  const addressText = [address.name, address.line1, `${address.city ?? ''}, ${address.state ?? ''} ${address.pin ?? ''}`, address.phone]
    .filter((part) => part && part.trim() !== ',')
    .join('\n');
  const payment = paymentLabel(order.payment);
  const number = invoiceNumber(order);
  const subject = `DesignWear receipt for order #${order.id}`;

  const textLines = lines.map(
    (l) => `${l.quantity} x ${l.title} (size ${l.size})  ${rupees(l.unitPrice * l.quantity)}`,
  );
  const text = [
    `Thank you for your order!`,
    ``,
    `Order #${order.id}`,
    `Receipt ${number}`,
    `Date ${dateOf(order.createdAt)}`,
    ``,
    ...textLines,
    ``,
    `Subtotal  ${rupees(order.subtotal)}`,
    `GST (18%) ${rupees(order.tax)}`,
    `Total     ${rupees(order.total)}`,
    ``,
    `Payment: ${payment}`,
    ``,
    `Delivering to:`,
    addressText,
    ``,
    supportEmail ? `Questions? Write to ${supportEmail}.` : '',
  ].join('\n');

  const rows = lines
    .map(
      (l) => `<tr><td style="padding:6px 0">${escapeHtml(l.title)}<br><span style="color:#666;font-size:12px">Size ${escapeHtml(l.size)} · Qty ${escapeHtml(l.quantity)}</span></td><td style="padding:6px 0;text-align:right">${rupees(l.unitPrice * l.quantity)}</td></tr>`,
    )
    .join('');
  const total = (label, value, bold = false) =>
    `<tr><td style="padding:3px 0;${bold ? 'font-weight:bold' : ''}">${label}</td><td style="padding:3px 0;text-align:right;${bold ? 'font-weight:bold' : ''}">${value}</td></tr>`;

  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f6;font-family:Arial,sans-serif;color:#111">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="background:#fff;border-radius:12px;padding:24px">
<h2 style="margin:0 0 4px">Thank you for your order!</h2>
<p style="margin:0 0 16px;color:#555">Order <b>#${escapeHtml(order.id)}</b> · Receipt ${escapeHtml(number)} · ${escapeHtml(dateOf(order.createdAt))}</p>
<table style="width:100%;border-collapse:collapse;border-top:1px solid #eee">${rows}</table>
<table style="width:100%;border-collapse:collapse;border-top:1px solid #eee;margin-top:8px">
${total('Subtotal', rupees(order.subtotal))}${total('GST (18%)', rupees(order.tax))}${total('Total', rupees(order.total), true)}
</table>
<p style="margin:16px 0 4px"><b>Payment</b><br>${escapeHtml(payment)}</p>
<p style="margin:12px 0 4px"><b>Delivering to</b><br>${escapeHtml(addressText).replace(/\n/g, '<br>')}</p>
${supportEmail ? `<p style="margin:16px 0 0;color:#666;font-size:12px">Questions? Write to ${escapeHtml(supportEmail)}.</p>` : ''}
</div></div></body></html>`;

  return { subject, text, html };
}
