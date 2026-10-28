import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiProvider } from '../src/ai.js';
import { loadConfig } from '../src/config.js';

describe('Gemini models', () => {
  it('uses gemini-4-argon for chat and for images unless overridden', () => {
    const config = loadConfig({ GEMINI_API_KEY: 'k' });
    assert.equal(config.gemini.model, 'gemini-4-argon');
    assert.equal(config.gemini.imageModel, 'gemini-4-argon');
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
    assert.match(calls[0].url, /models\/gemini-4-argon:generateContent/);
    assert.deepEqual(calls[0].body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);

    await ai.designAgent({ message: 'hi', history: [], images: [], design: '{}' });
    assert.match(calls[1].url, /models\/gemini-4-argon:generateContent/);
    assert.equal(calls[1].body.generationConfig.responseModalities, undefined, 'chat stays text only');
  });
});
