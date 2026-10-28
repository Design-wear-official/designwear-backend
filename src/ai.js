import { readFileSync } from 'node:fs';

import { HttpError } from './validate.js';

const DESIGN_PROMPT = readFileSync(new URL('./design_prompt.txt', import.meta.url), 'utf8');

function sniffMime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export class AiProvider {
  constructor({ gemini }, fetchImpl = fetch) {
    this.gemini = gemini;
    this.fetch = fetchImpl;
  }

  /** The Design Studio assistant (text model). */
  get agentConfigured() {
    return Boolean(this.gemini.apiKey);
  }
  get tryOnConfigured() {
    return Boolean(this.gemini.apiKey);
  }

  async tryOn(photo, product, garmentBytes = null) {
    if (!this.tryOnConfigured) throw new HttpError(503, 'ai_unavailable', 'Virtual try-on is not enabled.');
    const photoMime = sniffMime(photo);
    if (!photoMime) throw new HttpError(400, 'invalid_photo', 'Use a JPEG, PNG or WebP photo.');
    let garment = garmentBytes;
    if (!garment) {
      // Only the catalog's own image URL is fetched, never one supplied by the client.
      const garmentUrl = new URL(product.imageUrl);
      if (garmentUrl.protocol !== 'https:') throw new HttpError(502, 'ai_error', 'Product image is unavailable.');
      const g = await this.fetch(garmentUrl, { redirect: 'error' });
      if (!g.ok) throw new HttpError(502, 'ai_error', 'Product image is unavailable.');
      garment = Buffer.from(await g.arrayBuffer());
    }
    const garmentMime = sniffMime(garment);
    if (!garmentMime || garment.length > 6_000_000) throw new HttpError(502, 'ai_error', 'Product image is unavailable.');

    const res = await this.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.gemini.imageModel)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.gemini.apiKey },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: `Show the person in the first image wearing the garment in the second image ("${product.title}"). Keep their face, pose and background unchanged.` },
              { inline_data: { mime_type: photoMime, data: photo.toString('base64') } },
              { inline_data: { mime_type: garmentMime, data: garment.toString('base64') } },
            ],
          }],
        }),
      },
    );
    if (!res.ok) throw new HttpError(502, 'ai_error', 'Virtual try-on is unavailable right now.');
    const body = await res.json();
    for (const part of body.candidates?.[0]?.content?.parts ?? []) {
      const data = part.inlineData?.data ?? part.inline_data?.data;
      if (data) return data;
    }
    throw new HttpError(502, 'ai_error', 'Try-on produced no image. Try a clearer photo.');
  }

  /** Design Studio assistant: returns { text, design? } where design is the model's JSON edit. */
  async designAgent({ message, history, images, design }) {
    if (!this.agentConfigured) throw new HttpError(503, 'ai_unavailable', 'The assistant is not enabled.');
    const contents = history.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const parts = [{ text: message }];
    for (const data of images) {
      const mime = sniffMime(Buffer.from(data.slice(0, 32), 'base64'));
      if (mime) parts.push({ inline_data: { mime_type: mime, data } });
    }
    contents.push({ role: 'user', parts });
    const res = await this.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.gemini.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.gemini.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: DESIGN_PROMPT.replace('{{CURRENT_STATE}}', design) }] },
          contents,
          generationConfig: { maxOutputTokens: 2000 },
        }),
      },
    );
    if (!res.ok) throw new HttpError(502, 'ai_error', 'The assistant is unavailable right now.');
    const body = await res.json();
    const text = (body.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
    if (!text) throw new HttpError(502, 'ai_error', 'The assistant returned no answer.');

    let edit = null;
    const match = /```json\s*(\{[\s\S]*\})\s*```/.exec(text);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed && typeof parsed.design === 'object' && Array.isArray(parsed.design.elements) && parsed.design.elements.length <= 60) {
          edit = parsed.design;
        }
      } catch { /* a malformed edit is ignored; the text reply still goes through */ }
    }
    const reply = text.split('```json')[0].trim() || (edit ? 'Design updated.' : text);
    return { text: reply, design: edit };
  }

  /** A graphic for the design (PNG, base64) from the image model. */
  async designImage(prompt) {
    if (!this.tryOnConfigured) throw new HttpError(503, 'ai_unavailable', 'Image generation is not enabled.');
    const res = await this.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.gemini.imageModel)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.gemini.apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `A bold, print-ready graphic for a T-shirt, transparent or plain background, no text: ${prompt}` }] }],
        }),
      },
    );
    if (!res.ok) throw new HttpError(502, 'ai_error', 'Image generation is unavailable right now.');
    const body = await res.json();
    for (const part of body.candidates?.[0]?.content?.parts ?? []) {
      const data = part.inlineData?.data ?? part.inline_data?.data;
      if (data) return data;
    }
    throw new HttpError(502, 'ai_error', 'No image was produced.');
  }
}
