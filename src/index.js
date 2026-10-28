import { createServer } from 'node:http';

import { AiProvider } from './ai.js';
import { createApp } from './app.js';
import { CmsCatalog } from './catalog.js';
import { loadConfig } from './config.js';
import { FileSink, createLogger } from './logger.js';
import { WebhookMailer } from './mailer.js';
import { Store } from './store.js';

const config = loadConfig();
const store = await new Store(config.dataFile).load();
const logger = createLogger();
// Reports from the app also go to a rotating file, so they survive log retention on stdout.
const clientLogger = createLogger({
  sink: (line) => {
    process.stdout.write(line + '\n');
    clientFile.write(line);
  },
});
const clientFile = new FileSink(config.clientLogFile);
const handler = createApp({
  config,
  logger,
  clientLogger,
  store,
  catalog: new CmsCatalog(config.cms),
  ai: new AiProvider(config),
  mailer: new WebhookMailer(config.mailWebhookUrl),
});

const server = createServer(handler);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(config.port, config.host, () => {
  console.log(`DesignWear API on http://${config.host}:${config.port}`);
});
