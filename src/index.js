import { createServer } from 'node:http';

import { buildApp } from './bootstrap.js';

const { config, handler } = await buildApp();

const server = createServer(handler);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(config.port, config.host, () => {
  console.log(`DesignWear API on http://${config.host}:${config.port}`);
});
