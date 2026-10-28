// Vercel entry point: every /v1/* request is rewritten here (see vercel.json).
// The app is built once per warm instance and reused across requests.
import { buildApp } from '../src/bootstrap.js';

let appPromise;

export default async function handler(req, res) {
  appPromise ??= buildApp().then(({ handler }) => handler);
  const app = await appPromise;
  return app(req, res);
}
