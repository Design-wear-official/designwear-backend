/**
 * Sends mail through a webhook you control (SES/Resend/Zapier…). With no webhook,
 * development prints the message; production only notes that it was skipped, because
 * the text holds a password-reset code that must not end up in logs.
 */
export class WebhookMailer {
  constructor(url, fetchImpl = fetch, { printUnsent = true } = {}) {
    this.url = url;
    this.fetch = fetchImpl;
    this.printUnsent = printUnsent;
  }
  async send(to, subject, text, { html } = {}) {
    if (!this.url) {
      if (this.printUnsent) console.log(`[mail:dev] to=${to} subject=${subject}\n${text}`);
      else console.warn(`Mail not sent (MAIL_WEBHOOK_URL is not set): ${subject}`);
      return;
    }
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, subject, text, ...(html ? { html } : {}) }),
    });
    if (!res.ok) throw new Error(`Mail webhook failed: ${res.status}`);
  }
}
