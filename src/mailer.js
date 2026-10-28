/** Sends mail through a webhook you control (SES/Resend/Zapier…). Dev logs instead. */
export class WebhookMailer {
  constructor(url, fetchImpl = fetch) {
    this.url = url;
    this.fetch = fetchImpl;
  }
  async send(to, subject, text) {
    if (!this.url) {
      console.log(`[mail:dev] to=${to} subject=${subject}\n${text}`);
      return;
    }
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, subject, text }),
    });
    if (!res.ok) console.error('Mail webhook failed:', res.status);
  }
}
