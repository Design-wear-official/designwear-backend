// The official SethuCMS SDK (@sethucms/sdk), set up the way this API uses it. Every call to the
// gateway goes through here: the SDK adds the Bearer token and an Idempotency-Key to writes, can
// retry reads, times out, and reports failures as SethuApiError.
//
// The SDK is loaded when this module is, but a missing install only matters once a SethuCMS
// feature is used: a checkout that never ran `npm ci` still starts with the file or Redis store.
let sdk = null;
try {
  sdk = await import('@sethucms/sdk');
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const needSdk = () => {
  if (!sdk) throw new Error('@sethucms/sdk is not installed. Run `npm ci` in the API folder.');
  return sdk;
};

export const eq = (...args) => needSdk().eq(...args);

/**
 * A client for one gateway address and token.
 *   timeoutMs   per attempt; maxRetries   extra attempts for reads only (writes are never retried).
 *   allowHttp   accept a plain-http address that is not localhost (a private network). Off by default.
 *   fetchImpl   for tests.
 * Redirects are refused, as they were before the SDK: a gateway address that redirects is a mistake
 * or an attack, and the call fails instead of following it.
 */
export function sethuClient({ url, token, fetchImpl, timeoutMs = 10_000, maxRetries = 2, allowHttp = false }) {
  const send = fetchImpl ?? fetch;
  return new (needSdk().SethuClient)({
    baseUrl: url,
    token,
    timeoutMs,
    maxRetries,
    allowInsecureHttp: allowHttp,
    fetch: (target, init) => send(target, { ...init, redirect: 'error' }),
  });
}

const isSethuError = (error) => Boolean(sdk?.isSethuApiError(error));

/** True when `error` is a SethuCMS error with one of these HTTP statuses (for example 404). */
export const hasStatus = (error, ...statuses) => isSethuError(error) && statuses.includes(error.status);


/**
 * Why a call failed, for an error message: the HTTP status when there was one, otherwise the SDK's
 * code (TIMEOUT, CONNECTION_FAILED) or the error's name (TypeError for a bad address, RangeError ...),
 * so ":0" never hides the cause.
 */
export const failureOf = (error) => {
  if (isSethuError(error)) return error.status > 0 ? String(error.status) : String(error.code ?? 'UNKNOWN');
  return String(error?.name ?? 'Error');
};
