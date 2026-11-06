// Test stand-ins for the SethuCMS gateway. The SDK reads real Response objects, so the older
// fakes (which return { ok, status, json }) are wrapped with asGateway().

/** A real Response for a status and JSON body. */
export const reply = (status, body, headers = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body ?? {}), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Wraps a fake fetch so whatever it returns (a Response, or { ok, status, json }) becomes a Response. */
export const asGateway = (fake) => async (url, init = {}) => {
  // The SDK sends "Authorization" and "Idempotency-Key"; the fakes read them lower-case, and want a string URL.
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const out = await fake(String(url), { ...init, headers });
  if (out instanceof Response) return out;
  const body = typeof out.json === 'function' ? await out.json() : {};
  // The real gateway answers lists as { data, page: { nextCursor } }; older fakes used a bare nextCursor.
  if (Array.isArray(body.data) && !body.page) body.page = { nextCursor: body.nextCursor ?? null };
  return reply(out.status ?? (out.ok ? 200 : 500), body);
};
