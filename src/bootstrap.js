// Builds the API from environment settings. Shared by the long-running server
// (index.js) and the Vercel function (api/index.js).
import { AiProvider } from './ai.js';
import { createApp } from './app.js';
import { CmsCatalog } from './catalog.js';
import { loadConfig } from './config.js';
import { FileSink, createLogger } from './logger.js';
import { WebhookMailer } from './mailer.js';
import { createStore } from './store.js';

export async function buildApp(env = process.env) {
  const config = loadConfig(env);
  const store = await createStore(config);
  const logger = createLogger();

  // Reports from the app also go to a rotating file on a normal server. A
  // serverless host has no disk, so there they only go to the platform logs.
  let clientLogger = logger;
  if (!config.serverless) {
    const clientFile = new FileSink(config.clientLogFile);
    clientLogger = createLogger({
      sink: (line) => {
        process.stdout.write(line + '\n');
        clientFile.write(line);
      },
    });
  }

  const handler = createApp({
    config,
    logger,
    clientLogger,
    store,
    catalog: new CmsCatalog(config.cms),
    ai: new AiProvider(config),
    mailer: new WebhookMailer(config.mailWebhookUrl),
  });
  return { config, handler };
}
