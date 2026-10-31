import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiProvider } from '../src/ai.js';
import { loadConfig } from '../src/config.js';

describe('Gemini models', () => {
  it('uses gemini-3.8-flash for chat and gemini-nano-banana-2.1 for images unless overridden', () => {
    const config = loadConfig({ GEMINI_API_KEY: 'k' });
    assert.equal(config.gemini.model, 'gemini-3.8-flash');
    assert.equal(config.gemini.imageModel, 'gemini-nano-banana-2.1');
    const custom = loadConfig({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'a', GEMINI_IMAGE_MODEL: 'b' });
    assert.deepEqual([custom.gemini.model, custom.gemini.imageModel], ['a', 'b']);
  });

  it('asks the image model for a picture and the chat model for text', async () => {
    const calls = [];
    const ai = new AiProvider(loadConfig({ GEMINI_API_KEY: 'k' }), async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: 'QUJD' } }, { text: 'ok' }] } }] }),
      };
    });

    assert.equal(await ai.designImage('a sunrise'), 'QUJD');
    assert.match(calls[0].url, /models\/gemini-nano-banana-2\.1:generateContent/);
    assert.deepEqual(calls[0].body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);

    await ai.designAgent({ message: 'hi', history: [], images: [], design: '{}' });
    assert.match(calls[1].url, /models\/gemini-3\.8-flash:generateContent/);
    assert.equal(calls[1].body.generationConfig.responseModalities, undefined, 'chat stays text only');
  });

  it('logs why Google refused, without the key, while the customer gets a generic error', async () => {
    const lines = [];
    const logger = { error: (message) => lines.push(message) };
    const ai = new AiProvider(
      loadConfig({ GEMINI_API_KEY: 'secret-key' }),
      async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'Requests to this API are blocked.' } }),
      }),
      logger,
    );
    await assert.rejects(() => ai.designAgent({ message: 'hi', history: [], images: [], design: '{}' }), /unavailable/);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /gemini-3\.8-flash answered 403: PERMISSION_DENIED Requests to this API are blocked/);
    assert.ok(!lines[0].includes('secret-key'));
  });
});
