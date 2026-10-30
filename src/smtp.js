/**
 * A small SMTP client: connect, upgrade to TLS, sign in, send one message.
 * Port 465 starts encrypted; any other port must offer STARTTLS, and the password
 * is never sent over a plain connection unless `insecure` is set (tests only).
 */
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const noBreaks = (value) => String(value).replace(/[\r\n]+/g, ' ').trim();
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const wrap = (text) => text.replace(/(.{76})/g, '$1\r\n');

// Non-ASCII headers travel as an RFC 2047 encoded word.
function headerText(value) {
  const clean = noBreaks(value);
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${b64(clean)}?=`;
}

/** The plain address inside "Name <a@b.c>" or "a@b.c". */
function bareAddress(value) {
  const text = noBreaks(value);
  return /<([^>]+)>/.exec(text)?.[1] ?? text;
}

/** Builds the full message: text and HTML alternatives, both base64. */
export function buildMessage({ from, to, subject, text, html, now = Date.now(), domain = 'designwear' }) {
  const boundary = `dw-${randomBytes(12).toString('hex')}`;
  const headers = [
    `From: ${noBreaks(from)}`,
    `To: ${noBreaks(to)}`,
    `Subject: ${headerText(subject)}`,
    `Date: ${new Date(now).toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
  ];
  const part = (type, body) =>
    `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(b64(body))}\r\n`;

  if (html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return `${headers.join('\r\n')}\r\n\r\n${part('text/plain', text)}${part('text/html', html)}--${boundary}--\r\n`;
  }
  headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
  return `${headers.join('\r\n')}\r\n\r\n${wrap(b64(text))}\r\n`;
}

// Reads server replies, joining multi-line answers ("250-..." then "250 ...").
class Session {
  constructor(socket) {
    this.pending = [];
    this.replies = [];
    this.buffer = '';
    this.error = null;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    this.onData = (chunk) => {
      this.buffer += chunk;
      const lines = this.buffer.split('\r\n');
      this.buffer = lines.pop();
      for (const line of lines) {
        this.lines = [...(this.lines ?? []), line];
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          this.replies.push({ code: Number(line.slice(0, 3)), lines: this.lines });
          this.lines = [];
        }
      }
      this.drain();
    };
    this.onFail = (error) => this.fail(error instanceof Error ? error : new Error('SMTP connection closed'));
    socket.on('data', this.onData);
    socket.on('error', this.onFail);
    socket.on('close', this.onFail);
    socket.on('timeout', () => this.fail(new Error('SMTP timed out')));
  }

  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onFail);
    this.socket.off('close', this.onFail);
  }

  fail(error) {
    this.error ??= error;
    for (const { reject } of this.pending.splice(0)) reject(this.error);
  }

  drain() {
    while (this.pending.length && this.replies.length) {
      this.pending.shift().resolve(this.replies.shift());
    }
  }

  read() {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  async expect(codes) {
    const reply = await this.read();
    if (!codes.includes(reply.code)) {
      throw new Error(`SMTP ${reply.code}: ${reply.lines.at(-1).slice(4)}`);
    }
    return reply;
  }

  async command(line, codes) {
    this.socket.write(`${line}\r\n`);
    return this.expect(codes);
  }
}

export class SmtpMailer {
  constructor({ host, port = 587, user = '', pass = '', from, insecure = false, timeoutMs = 15_000 }) {
    if (!host || !from) throw new Error('SMTP_HOST and MAIL_FROM are required');
    Object.assign(this, { host, port: Number(port), user, pass, from, insecure, timeoutMs });
  }

  async send(to, subject, text, { html } = {}) {
    const message = buildMessage({ from: this.from, to, subject, text, html, domain: this.host });
    const implicitTls = this.port === 465;
    const socket = implicitTls
      ? tls.connect({ host: this.host, port: this.port, servername: this.host })
      : net.connect({ host: this.host, port: this.port });
    socket.setTimeout(this.timeoutMs);
    const session = new Session(socket);

    try {
      await session.expect([220]);
      const helo = 'designwear.local';
      let ehlo = await session.command(`EHLO ${helo}`, [250]);

      if (!implicitTls) {
        const offersTls = ehlo.lines.some((l) => /STARTTLS/i.test(l));
        if (offersTls) {
          await session.command('STARTTLS', [220]);
          session.detach();
          const secured = tls.connect({ socket, servername: this.host });
          secured.setTimeout(this.timeoutMs);
          session.attach(secured);
          await new Promise((resolve, reject) => {
            secured.once('secureConnect', resolve);
            secured.once('error', reject);
          });
          ehlo = await session.command(`EHLO ${helo}`, [250]);
        } else if (!this.insecure) {
          throw new Error('SMTP server does not offer STARTTLS; refusing to send without encryption');
        }
      }

      if (this.user) {
        const methods = ehlo.lines.join(' ');
        if (/AUTH[^\r\n]*PLAIN/i.test(methods) || !/AUTH[^\r\n]*LOGIN/i.test(methods)) {
          await session.command(`AUTH PLAIN ${b64(`\0${this.user}\0${this.pass}`)}`, [235]);
        } else {
          await session.command('AUTH LOGIN', [334]);
          await session.command(b64(this.user), [334]);
          await session.command(b64(this.pass), [235]);
        }
      }

      await session.command(`MAIL FROM:<${bareAddress(this.from)}>`, [250]);
      await session.command(`RCPT TO:<${bareAddress(to)}>`, [250, 251]);
      await session.command('DATA', [354]);
      const stuffed = message.replace(/^\./gm, '..');
      session.socket.write(`${stuffed}\r\n.\r\n`);
      await session.expect([250]);
      session.socket.write('QUIT\r\n');
    } finally {
      session.socket.destroy();
    }
  }
}
