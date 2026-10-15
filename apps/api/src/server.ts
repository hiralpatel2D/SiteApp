import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { createApp } from './app';
import { createPools } from './db/pools';
import { consoleEmailSender } from './email/email';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const pools = createPools(config);

// Health ping on the restricted app pool (the connection requests actually use).
const checkDb = async (): Promise<boolean> => {
  try {
    await pools.app.query('select 1');
    return true;
  } catch {
    return false;
  }
};

const app = createApp({ checkDb, pools, config, email: consoleEmailSender });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`API listening on port ${info.port}`);
}) as Server;

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    Promise.all([pools.owner.end(), pools.app.end()])
      .catch((err: unknown) => console.error(err))
      .finally(() => process.exit(0));
  });
  // Drop idle keep-alive connections so close() can complete promptly.
  server.closeIdleConnections?.();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
