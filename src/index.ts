import { join } from 'node:path';
import { createApp } from './app.ts';
import { MAX_BYTES } from './uploads.ts';

// Both folders are [storage] keep paths: ox links them into $OX_DATA_DIR,
// because the release itself is read-only while it runs.
const root = join(import.meta.dir, '..');
const { app } = createApp({ env: process.env, dataDir: join(root, 'data'), uploadsDir: join(root, 'uploads') });

export default {
  hostname: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
  maxRequestBodySize: MAX_BYTES + 64 * 1024,
  fetch: app.fetch,
};
