// One place that tells a customer something: it goes into their in-app inbox, to
// their email, and to their phones (push), each best effort. Nothing here may
// stop an order from going through.
import { randomBytes } from 'node:crypto';

const INBOX_LIMIT = 50;
const DEVICE_LIMIT = 5;

// What the customer reads for each step of an order.
export function orderMessage(order, status = order.status, note = '') {
  const id = `#${order.id}`;
  const tracking = order.tracking?.id
    ? ` Tracking: ${[order.tracking.carrier, order.tracking.id].filter(Boolean).join(' ')}.`
    : '';
  const messages = {
    placed: ['Order placed', `We got your order ${id}. We'll let you know when it's confirmed.`],
    paid: ['Payment received', `Payment for order ${id} went through. Thank you!`],
    confirmed: ['Order confirmed', `Order ${id} is confirmed and will be made now.`],
    packed: ['Order packed', `Order ${id} is packed and ready to ship.`],
    shipped: ['Order on its way', `Order ${id} has been shipped.${tracking}`],
    delivered: ['Order delivered', `Order ${id} was delivered. Enjoy your DesignWear!`],
    cancelled: ['Order cancelled', `Order ${id} was cancelled.`],
  };
  const [title, body] = messages[status] ?? ['Order update', `Order ${id} is now ${status}.`];
  return { title, body: note ? `${body} ${note}` : body };
}

export function createNotifier({ store, mailer, push, logger, now }) {
  async function inbox(userId) {
    return (await store.get('inbox', userId)) ?? { id: userId, items: [], readAt: null };
  }

  // Adds to the inbox, then emails and pushes. `email: false` skips the email.
  async function notify(user, { type, title, body, orderId = null, email = true, mail = null }) {
    const at = new Date(now()).toISOString();
    try {
      const box = await inbox(user.id);
      const item = { id: randomBytes(6).toString('hex'), type, title, body, orderId, at, read: false };
      box.items = [item, ...box.items].slice(0, INBOX_LIMIT);
      await store.put('inbox', user.id, box);
    } catch (error) {
      logger.error(`Inbox write failed for ${user.id}: ${error.message}`, error);
    }

    if (email && user.email) {
      await Promise.resolve()
        .then(() => {
          const message = mail ?? { subject: `DesignWear: ${title}`, text: body };
          return mailer.send(user.email, message.subject, message.text, {
            html: message.html,
            kind: type,
            orderId,
            userId: user.id,
          });
        })
        .catch((error) => {
          logger.error(`Notification email failed: ${error.message}`, error);
        });
    }

    if (push.enabled) {
      try {
        const devices = (await store.get('devices', user.id)) ?? { id: user.id, items: [] };
        const tokens = devices.items.map((d) => d.token);
        const { invalid } = await push.send(tokens, { title, body, data: { type, orderId: orderId ?? '' } });
        if (invalid.length) {
          devices.items = devices.items.filter((d) => !invalid.includes(d.token));
          await store.put('devices', user.id, devices);
        }
      } catch (error) {
        logger.error(`Push failed for ${user.id}: ${error.message}`, error);
      }
    }
  }

  async function list(userId) {
    const box = await inbox(userId);
    const unread = box.items.filter((item) => !item.read).length;
    return { items: box.items, unread };
  }

  async function markAllRead(userId) {
    const box = await inbox(userId);
    box.items = box.items.map((item) => ({ ...item, read: true }));
    await store.put('inbox', userId, box);
  }

  async function addDevice(userId, token, platform) {
    const devices = (await store.get('devices', userId)) ?? { id: userId, items: [] };
    const others = devices.items.filter((d) => d.token !== token);
    devices.items = [{ token, platform, at: new Date(now()).toISOString() }, ...others].slice(0, DEVICE_LIMIT);
    await store.put('devices', userId, devices);
  }

  async function removeDevice(userId, token) {
    const devices = await store.get('devices', userId);
    if (!devices) return;
    devices.items = devices.items.filter((d) => d.token !== token);
    await store.put('devices', userId, devices);
  }

  return { notify, list, markAllRead, addDevice, removeDevice };
}
