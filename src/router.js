// A tiny router: patterns like '/v1/orders/:orderId/cancel' become regexes.
export function createRouter() {
  const routes = [];

  function route(method, pattern, handler) {
    const keys = [];
    const source = pattern.replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    routes.push({ method, re: new RegExp(`^${source}$`), keys, handler });
  }

  // The route for this method and path, with its decoded :params, or null.
  function match(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1]);
      });
      return { handler: r.handler, params };
    }
    return null;
  }

  // True when some route exists for the path under a different method (405).
  function pathExists(pathname) {
    return routes.some((r) => r.re.test(pathname));
  }

  return { route, match, pathExists };
}
