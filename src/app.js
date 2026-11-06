// Wires the API together: shared context, one module per area of routes, and
// the HTTP handler that dispatches to them.
import { createContext } from './context.js';
import { createHandler } from './handler.js';
import { createPresenters } from './presenters.js';
import { createRouter } from './router.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCartRoutes } from './routes/cart.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerChallengeRoutes } from './routes/challenges.js';
import { registerDesignRoutes } from './routes/designs.js';
import { registerHookRoutes } from './routes/hooks.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerOrderRoutes } from './routes/orders.js';
import { registerPrintRoutes } from './routes/print.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerStaffRoutes } from './routes/staff.js';
import { registerSystemRoutes } from './routes/system.js';

export function createApp(deps) {
  const ctx = createContext(deps);
  const presenters = createPresenters(ctx);
  const router = createRouter();

  registerSystemRoutes(router, ctx);
  registerAuthRoutes(router, ctx);
  registerAccountRoutes(router, ctx);
  registerCartRoutes(router, ctx);
  registerOrderRoutes(router, ctx);
  registerPrintRoutes(router, ctx);
  registerStaffRoutes(router, ctx);
  registerNotificationRoutes(router, ctx);
  registerHookRoutes(router, ctx);
  registerPaymentRoutes(router, ctx);
  registerDesignRoutes(router, ctx, presenters);
  registerChallengeRoutes(router, ctx, presenters);
  registerCatalogRoutes(router, ctx);
  registerAiRoutes(router, ctx);

  const handler = createHandler({ ctx, router });
  handler.routes = router.list; // lets the OpenAPI drift test and spec generator see every route
  return handler;
}
