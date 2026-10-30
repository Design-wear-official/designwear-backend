import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';

import { SmtpMailer, buildMessage } from '../src/smtp.js';
import { receiptEmail } from '../src/receipt.js';

// A stand-in SMTP server that records what the client says. `failAt` makes it
// refuse a command with a 550.
function fakeServer({ failAt = null, auth = true } = {}) {
  const seen = { commands: [], data: '' };
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 queued\r\n');
          } else {
            seen.data += line + '\r\n';
          }
          continue;
        }
        seen.commands.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (failAt === verb) socket.write('550 refused\r\n');
        else if (verb === 'EHLO') socket.write(`250-fake\r\n${auth ? '250-AUTH PLAIN LOGIN\r\n' : ''}250 8BITMIME\r\n`);
        else if (verb === 'AUTH') socket.write('235 ok\r\n');
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

const decode = (raw, type) => {
  const part = raw.split('--').find((p) => p.includes(`Content-Type: ${type}`));
  const body = part.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  return Buffer.from(body, 'base64').toString('utf8');
};

describe('SmtpMailer', () => {
  it('sends a text+HTML message after signing in', async () => {
    const { server, seen, port } = await fakeServer();
    try {
      const mailer = new SmtpMailer({ host: '127.0.0.1', port, user: 'u', pass: 'p', from: 'DesignWear <hi@designwear.test>', insecure: true });
      await mailer.send('ada@example.com', 'Receipt ₹', 'plain body', { html: '<b>html body</b>' });
      assert.ok(seen.commands.some((c) => c.startsWith('AUTH PLAIN')));
      assert.ok(seen.commands.includes('MAIL FROM:<hi@designwear.test>'));
      assert.ok(seen.commands.includes('RCPT TO:<ada@example.com>'));
      assert.match(seen.data, /Subject: =\?UTF-8\?B\?/);
      assert.equal(decode(seen.data, 'text/plain'), 'plain body');
      assert.equal(decode(seen.data, 'text/html'), '<b>html body</b>');
    } finally {
      server.close();
    }
  });

  it('reports a refused recipient as an error', async () => {
    const { server, port } = await fakeServer({ failAt: 'RCPT' });
    try {
      const mailer = new SmtpMailer({ host: '127.0.0.1', port, from: 'hi@designwear.test', insecure: true });
      await assert.rejects(() => mailer.send('bad@example.com', 's', 't'), /550/);
    } finally {
      server.close();
    }
  });

  it('refuses to send a password over a server that cannot encrypt', async () => {
    const { server, port } = await fakeServer();
    try {
      const mailer = new SmtpMailer({ host: '127.0.0.1', port, user: 'u', pass: 'p', from: 'hi@designwear.test' });
      await assert.rejects(() => mailer.send('a@b.co', 's', 't'), /STARTTLS/);
    } finally {
      server.close();
    }
  });

  it('cannot be tricked into extra headers or recipients through line breaks', () => {
    const raw = buildMessage({ from: 'a@b.co', to: 'x@y.co\r\nBcc: evil@z.co', subject: 'Hi\r\nBcc: evil@z.co', text: 't' });
    assert.ok(!/^Bcc:/m.test(raw));
  });
});

describe('receiptEmail', () => {
  const order = {
    id: 'DW1', createdAt: '2026-10-30T10:00:00.000Z', subtotal: 500, tax: 90, total: 590,
    lines: [{ title: '<script>x</script> Tee', size: 'M', quantity: 2, unitPrice: 250 }],
    address: { name: 'Ada', line1: '1 Road', city: 'Pune', state: 'MH', pin: '411001', phone: '9999999999' },
    payment: { status: 'paid', paymentId: 'pay_1' },
  };

  it('lists items, GST, total and payment, and escapes customer text', () => {
    const { subject, text, html } = receiptEmail(order, { supportEmail: 'help@designwear.test' });
    assert.match(subject, /#DW1/);
    assert.match(text, /2 x <script>x<\/script> Tee \(size M\)\s+Rs 500\.00/);
    assert.match(text, /GST \(18%\)\s+Rs 90\.00/);
    assert.match(text, /Paid online \(payment pay_1\)/);
    assert.ok(!html.includes('<script>'));
    assert.match(html, /help@designwear\.test/);
  });

  it('says pay on delivery for cash orders', () => {
    const { text } = receiptEmail({ ...order, payment: { method: 'cod', status: 'pay_on_delivery' } });
    assert.match(text, /Pay on delivery/);
  });
});
