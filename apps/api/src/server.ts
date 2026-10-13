import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { createApp } from './app';
import { createPools } from './db/pools';

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

const app = createApp({ checkDb });
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`API listening on port ${info.port}`);
});
