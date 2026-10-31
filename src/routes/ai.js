// AI features. Prompts and API keys stay on the server.
import * as v from '../validate.js';
import { bad } from '../validate.js';

const MIN_IMAGE_BYTES = 100;
const MAX_PHOTO_BYTES = 6_000_000;
const MAX_GARMENT_IMAGE_BYTES = 3_000_000;

function decodeBase64(value) {
  return Buffer.from(String(value ?? ''), 'base64');
}

function isSized(buffer, max) {
  return buffer.length >= MIN_IMAGE_BYTES && buffer.length <= max;
}

export function registerAiRoutes(router, ctx) {
  const { catalog, ai } = ctx;

  router.route('POST', '/v1/ai/try-on', async ({ req }) => {
    const user = await ctx.authed(req);
    ctx.limit(`tryon:${user.id}`, 10, 3600_000);
    const body = await ctx.readBody(req, 12_000_000);

    const photo = decodeBase64(body.photo);
    if (!isSized(photo, MAX_PHOTO_BYTES)) {
      throw bad('invalid_photo', 'Photo must be under 6 MB.');
    }

    // Either a catalog product (its own image is fetched server-side) or the
    // customer's own design as an image. A URL is never accepted from the client.
    let garment = null;
    let item;
    if (body.garment) {
      garment = decodeBase64(body.garment);
      if (!isSized(garment, MAX_GARMENT_IMAGE_BYTES)) {
        throw bad('invalid_garment_image', 'Design image must be under 3 MB.');
      }
      item = { title: String(body.title ?? 'custom design').slice(0, 80) };
    } else {
      item = await catalog.product(String(body.productId ?? ''));
      if (!item?.imageUrl) throw bad('unknown_product');
    }

    const use = await ctx.quota.take(user);
    try {
      return { status: 200, body: { image: await ai.tryOn(photo, item, garment) } };
    } catch (error) {
      await use.release();
      throw error;
    }
  });

  // Design Studio assistant. Returns the reply text and, when the model
  // produced one, a design to apply.
  router.route('POST', '/v1/ai/design-agent', async ({ req }) => {
    const user = await ctx.authed(req);
    ctx.limit(`agent:${user.id}`, 60, 3600_000);
    const body = await ctx.readBody(req, 6_000_000);

    const message = v.str(String(body.message ?? ''), 'message', { max: 2000 });

    const history = (Array.isArray(body.history) ? body.history : [])
      .slice(-12)
      .map((turn) => ({
        role: turn?.role === 'assistant' ? 'assistant' : 'user',
        content: String(turn?.content ?? '').slice(0, 4000),
      }));

    const images = (Array.isArray(body.images) ? body.images : [])
      .slice(0, 3)
      .map(String)
      .filter((image) => image.length < 2_500_000);

    const design =
      body.design && typeof body.design === 'object'
        ? JSON.stringify(body.design).slice(0, 60_000)
        : '{}';

    const use = await ctx.quota.take(user);
    try {
      const reply = await ai.designAgent({ message, history, images, design });
      // A design edit comes with a pass for its graphic: one creation, not two.
      if (reply.design) reply.imagePass = await ctx.quota.grantPass(user);
      return { status: 200, body: reply };
    } catch (error) {
      await use.release();
      throw error;
    }
  });

  router.route('POST', '/v1/ai/design-image', async ({ req }) => {
    const user = await ctx.authed(req);
    ctx.limit(`dimage:${user.id}`, 20, 3600_000);

    const body = await ctx.readBody(req);
    const prompt = v.str(String(body.prompt ?? ''), 'prompt', { max: 400 });
    // The graphic for a design the assistant just made is covered by its pass.
    const covered = body.pass ? await ctx.quota.redeemPass(user, String(body.pass)) : false;
    const use = covered ? null : await ctx.quota.take(user);
    try {
      return { status: 200, body: { image: await ai.designImage(prompt) } };
    } catch (error) {
      await use?.release();
      throw error;
    }
  });
}
