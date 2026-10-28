import { readFileSync } from 'node:fs';

import { HttpError } from './validate.js';

const DESIGN_PROMPT = readFileSync(new URL('./design_prompt.txt', import.meta.url), 'utf8');

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_GARMENT_BYTES = 6_000_000;
const MAX_DESIGN_ELEMENTS = 60;

// Asks a general model (not only the dedicated image ones) to answer with a picture.
const IMAGE_OUTPUT = { responseModalities: ['TEXT', 'IMAGE'] };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The image type from the file's first bytes (never from a client-supplied name).
function sniffMime(buf) {
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  if (isJpeg) return 'image/jpeg';

  if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';

  const isWebp = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  if (isWebp) return 'image/webp';

  return null;
}

// The first generated image (base64) in a Gemini response, or undefined.
function firstImage(response) {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const data = part.inlineData?.data ?? part.inline_data?.data;
    if (data) return data;
  }
  return undefined;
}

// The model's JSON design edit, when it is well formed and a sane size.
function parseDesignEdit(jsonText) {
  try {
    const parsed = JSON.parse(jsonText);
    const design = parsed?.design;
    const valid =
      typeof design === 'object' &&
      Array.isArray(design.elements) &&
      design.elements.length <= MAX_DESIGN_ELEMENTS;
    return valid ? design : null;
  } catch {
    return null; // a malformed edit is ignored; the text reply still goes through
  }
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

  // POSTs a generateContent request to one of the Gemini models.
  generate(model, payload) {
    return this.fetch(`${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.gemini.apiKey,
      },
      body: JSON.stringify(payload),
    });
  }

  async tryOn(photo, product, garmentBytes = null) {
    if (!this.tryOnConfigured) {
      throw new HttpError(503, 'ai_unavailable', 'Virtual try-on is not enabled.');
    }

    const photoMime = sniffMime(photo);
    if (!photoMime) {
      throw new HttpError(400, 'invalid_photo', 'Use a JPEG, PNG or WebP photo.');
    }

    const garment = garmentBytes ?? (await this.fetchProductImage(product));
    const garmentMime = sniffMime(garment);
    if (!garmentMime || garment.length > MAX_GARMENT_BYTES) {
      throw new HttpError(502, 'ai_error', 'Product image is unavailable.');
    }

    const instruction =
      `Show the person in the first image wearing the garment in the second image ` +
      `("${product.title}"). Keep their face, pose and background unchanged.`;

    const response = await this.generate(this.gemini.imageModel, {
      generationConfig: IMAGE_OUTPUT,
      contents: [
        {
          parts: [
            { text: instruction },
            { inline_data: { mime_type: photoMime, data: photo.toString('base64') } },
            { inline_data: { mime_type: garmentMime, data: garment.toString('base64') } },
          ],
        },
      ],
    });
    if (!response.ok) {
      throw new HttpError(502, 'ai_error', 'Virtual try-on is unavailable right now.');
    }

    const image = firstImage(await response.json());
    if (!image) {
      throw new HttpError(502, 'ai_error', 'Try-on produced no image. Try a clearer photo.');
    }
    return image;
  }

  // Only the catalog's own image URL is fetched, never one supplied by the client.
  async fetchProductImage(product) {
    const unavailable = () =>
      new HttpError(502, 'ai_error', 'Product image is unavailable.');

    const url = new URL(product.imageUrl);
    if (url.protocol !== 'https:') throw unavailable();

    const response = await this.fetch(url, { redirect: 'error' });
    if (!response.ok) throw unavailable();
    return Buffer.from(await response.arrayBuffer());
  }

  /** Design Studio assistant: returns { text, design? } where design is the model's JSON edit. */
  async designAgent({ message, history, images, design }) {
    if (!this.agentConfigured) {
      throw new HttpError(503, 'ai_unavailable', 'The assistant is not enabled.');
    }

    const contents = history.map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }],
    }));

    const parts = [{ text: message }];
    for (const data of images) {
      const mime = sniffMime(Buffer.from(data.slice(0, 32), 'base64'));
      if (mime) parts.push({ inline_data: { mime_type: mime, data } });
    }
    contents.push({ role: 'user', parts });

    const response = await this.generate(this.gemini.model, {
      systemInstruction: {
        parts: [{ text: DESIGN_PROMPT.replace('{{CURRENT_STATE}}', design) }],
      },
      contents,
      generationConfig: { maxOutputTokens: 2000 },
    });
    if (!response.ok) {
      throw new HttpError(502, 'ai_error', 'The assistant is unavailable right now.');
    }

    const body = await response.json();
    const text = (body.candidates?.[0]?.content?.parts ?? [])
      .filter((part) => typeof part.text === 'string' && !part.thought)
      .map((part) => part.text)
      .join('')
      .trim();
    if (!text) {
      throw new HttpError(502, 'ai_error', 'The assistant returned no answer.');
    }

    const jsonBlock = /```json\s*(\{[\s\S]*\})\s*```/.exec(text);
    const edit = jsonBlock ? parseDesignEdit(jsonBlock[1]) : null;

    const reply = text.split('```json')[0].trim() || (edit ? 'Design updated.' : text);
    return { text: reply, design: edit };
  }

  /** A graphic for the design (PNG, base64) from the image model. */
  async designImage(prompt) {
    if (!this.tryOnConfigured) {
      throw new HttpError(503, 'ai_unavailable', 'Image generation is not enabled.');
    }

    const instruction =
      `A bold, print-ready graphic for a T-shirt, transparent or plain background, ` +
      `no text: ${prompt}`;

    const response = await this.generate(this.gemini.imageModel, {
      generationConfig: IMAGE_OUTPUT,
      contents: [{ parts: [{ text: instruction }] }],
    });
    if (!response.ok) {
      throw new HttpError(502, 'ai_error', 'Image generation is unavailable right now.');
    }

    const image = firstImage(await response.json());
    if (!image) throw new HttpError(502, 'ai_error', 'No image was produced.');
    return image;
  }
}
