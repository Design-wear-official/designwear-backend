// Daily limit on the generative features (assistant, design images, try-on), by plan.
// One shared counter per person per day (India time), kept in the database.
import { randomBytes } from 'node:crypto';

import { HttpError } from './validate.js';

export const PLANS = ['free', 'pro', 'ultra'];

const IST_OFFSET_MS = 5.5 * 3600_000;
const DAY_MS = 24 * 3600_000;
const PASS_TTL_MS = 10 * 60_000;

/** The calendar day in India for a timestamp, as YYYY-MM-DD. */
export const dayKey = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** When the day containing `ms` ends in India, as an ISO time. */
export const nextReset = (ms) => new Date(Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS + DAY_MS - IST_OFFSET_MS).toISOString();

/** The plan in force: free unless a paid plan is set and has not run out. */
export function planOf(user, nowMs) {
  const plan = PLANS.includes(user.plan) ? user.plan : 'free';
  if (plan === 'free') return 'free';
  if (user.planUntil && Date.parse(user.planUntil) < nowMs) return 'free';
  return plan;
}

export function createQuota({ store, config, now }) {
  const limits = config.aiDailyLimits;

  async function usage(user) {
    const at = now();
    const plan = planOf(user, at);
    const limit = limits[plan];
    const record = await store.get('aiusage', `${user.id}:${dayKey(at)}`);
    const used = record?.used ?? 0;
    return { plan, limit, used, remaining: Math.max(0, limit - used), resetsAt: nextReset(at) };
  }

  /**
   * Uses one of today's creations or throws 429. Returns { release }, which gives
   * it back when the provider fails, so a Google error never costs the customer a go.
   */
  async function take(user) {
    const at = now();
    const state = await usage(user);
    if (state.used >= state.limit) {
      const who = state.plan === 'free' ? 'free' : state.plan;
      const error = new HttpError(
        429,
        'ai_daily_limit',
        `You've used your ${state.limit} ${who} AI creations for today. They reset at midnight (India time).` +
          (state.plan === 'ultra' ? '' : ' Upgrade your plan for more.'),
      );
      error.details = { plan: state.plan, limit: state.limit, used: state.used, resetsAt: state.resetsAt };
      throw error;
    }
    const id = `${user.id}:${dayKey(at)}`;
    await store.put('aiusage', id, { id, userId: user.id, day: dayKey(at), used: state.used + 1 });
    return {
      async release() {
        const current = (await store.get('aiusage', id))?.used ?? 0;
        await store.put('aiusage', id, { id, userId: user.id, day: dayKey(at), used: Math.max(0, current - 1) });
      },
    };
  }

  // An assistant reply that edits the design hands back a pass for its graphic, so a
  // design and its picture count as one creation. One use, this person only, 10 minutes.
  async function grantPass(user) {
    const id = randomBytes(12).toString('base64url');
    await store.put('aipass', id, { id, userId: user.id, expires: now() + PASS_TTL_MS, used: false });
    return id;
  }

  async function redeemPass(user, pass) {
    const record = await store.get('aipass', pass);
    if (!record || record.userId !== user.id || record.used || record.expires < now()) return false;
    await store.put('aipass', pass, { ...record, used: true });
    return true;
  }

  return { usage, take, grantPass, redeemPass };
}
