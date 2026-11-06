// The official SethuCMS SDK (@sethucms/sdk), set up the way this API uses it. Every call to the
// gateway goes through here: the SDK adds the Bearer token and an Idempotency-Key to writes,
// retries reads on 429/502/503/504, times out, and reports failures as SethuApiError.
import { SethuClient, isSethuApiError } from '@sethucms/sdk';

export { eq } from '@sethucms/sdk';

/** A client for one gateway address and token. `fetchImpl` is for tests. */
export function sethuClient({ url, token, fetchImpl }) {
  return new SethuClient({
    baseUrl: url,
    token,
    timeoutMs: 10_000,
    ...(fetchImpl && { fetch: fetchImpl }),
  });
}

/** True when `error` is a SethuCMS error with one of these HTTP statuses (for example 404). */
export const hasStatus = (error, ...statuses) => isSethuApiError(error) && statuses.includes(error.status);

/** The HTTP status of a SethuCMS error, or 0 (could not reach it). */
export const statusOf = (error) => (isSethuApiError(error) ? error.status : 0);
