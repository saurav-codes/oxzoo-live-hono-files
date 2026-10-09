import { Hono, type Context } from 'hono';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { S3Client } from 'bun';
import { BUCKET, presignRoundTrip, s3Error, s3FromEnv, s3RoundTrip, withTimeout } from './s3.ts';
import { keepCheck, openDb, sqliteRoundTrip, type FileRow } from './store.ts';
import { ID_RE, MAX_BYTES, MAX_FILES, TYPES, displayName, newId, storedName, storedPath, validateUpload } from './uploads.ts';
import { corsHeaders, health, isZooCorsPath, parseOrigins, preflightHeaders, Prober, type Check, type Env, type VarSpec } from './zoo.ts';
import { page } from './page.ts';

export const META = { name: 'hono-files', stack: 'Bun + Hono + SQLite + SeaweedFS S3' };
const S3_ENV = ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'];
const VARS: VarSpec[] = [
  { name: 'ZOO_PANEL_ORIGIN', role: 'plain' },
  { name: 'S3_ENDPOINT', role: 'service', secret: true },
  { name: 'S3_ACCESS_KEY', role: 'service', secret: true },
  { name: 'S3_SECRET_KEY', role: 'service', secret: true },
];

export interface Options {
  env: Env;
  dataDir: string;
  uploadsDir: string;
  s3?: S3Client | null;
}

export function createApp(opts: Options) {
  const { env, dataDir, uploadsDir } = opts;
  mkdirSync(uploadsDir, { recursive: true });
  const db = openDb(dataDir);
  const s3 = opts.s3 === undefined ? s3FromEnv(env) : opts.s3;
  const origins = parseOrigins(env.ZOO_PANEL_ORIGIN);
  const started = new Date();
  const prober = new Prober();
  const app = new Hono();

  app.use('/_zoo/*', async (c, next) => {
    const origin = c.req.header('Origin');
    if (!isZooCorsPath(c.req.path)) return next();
    if (c.req.method === 'OPTIONS') return c.body(null, 204, preflightHeaders(origin, origins));
    await next();
    for (const [k, v] of Object.entries(corsHeaders(origin, origins))) c.header(k, v);
  });

  app.get('/_zoo/health', (c) => c.json(health(META, env, started, { runtime: `bun ${Bun.version}` })));

  app.get('/_zoo/probe', async (c) => {
    const checks: Check[] = [
      { id: 'sqlite', label: 'SQLite write, read, delete', env: [], run: async () => sqliteRoundTrip(db) },
      {
        id: 'keep',
        label: 'Kept folders data/ and uploads/ writable and persistent',
        env: [],
        run: async () => keepCheck({ data: dataDir, uploads: uploadsDir }, dataDir, (env.OX_RELEASE || 'unknown').slice(0, 12), env.OX_DATA_DIR),
      },
      { id: 's3', label: 'S3 PUT, GET, DELETE on SeaweedFS', env: S3_ENV, run: async () => s3RoundTrip(s3!) },
      { id: 's3-presign', label: 'S3 presigned PUT and GET', env: S3_ENV, run: (signal) => presignRoundTrip(s3!, signal) },
    ];
    try {
      const r = await prober.probe(META, env, checks, VARS);
      return c.json(r.body, r.status as 200 | 429);
    } catch (err) {
      console.error('probe failed:', (err as Error).message);
      return c.json({ error: 'probe failed' }, 500);
    }
  });

  const list = () => db.query('SELECT * FROM files ORDER BY created_at DESC LIMIT 100').all() as FileRow[];

  app.get('/', (c) => {
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    return c.html(page(list(), c.req.query('msg') ?? '', s3 !== null));
  });

  app.get('/files', (c) => c.json({ files: list().map(({ stored: _s, ...f }) => f) }));

  const done = (c: Context, status: number, msg: string, extra: Record<string, unknown> = {}) => {
    if ((c.req.header('Accept') ?? '').includes('application/json')) return c.json({ ok: status < 300, message: msg, ...extra }, status as 201);
    return c.redirect(`/?msg=${encodeURIComponent(msg)}`, 303);
  };

  app.post('/upload', async (c) => {
    const origin = c.req.header('Origin');
    if (origin && origin !== 'null' && new URL(origin).host !== c.req.header('Host')) return c.json({ error: 'cross-site upload refused' }, 403);
    if (Number(c.req.header('Content-Length') ?? 0) > MAX_BYTES + 64 * 1024) return done(c, 413, `file larger than ${MAX_BYTES} bytes`);
    let file: unknown;
    try {
      file = (await c.req.parseBody())['file'];
    } catch {
      return done(c, 400, 'expected a multipart form with a file field');
    }
    if (!(file instanceof File)) return done(c, 400, 'expected a multipart form with a file field');
    const head = new Uint8Array(await file.slice(0, MAX_BYTES + 1).arrayBuffer());
    const v = validateUpload(file.type, file.size, head);
    if (!v.ok) return done(c, v.status, v.error);
    const count = db.query('SELECT count(*) AS n FROM files').get() as { n: number };
    if (count.n >= MAX_FILES) return done(c, 507, `storage full (${MAX_FILES} files)`);

    const id = newId();
    const stored = storedName(id, v.type);
    writeFileSync(storedPath(uploadsDir, stored), head, { flag: 'wx' });
    let inS3 = 0;
    if (s3) {
      try {
        await withTimeout(s3.write(`files/${stored}`, head, { type: v.type }), 5000, 'S3 copy');
        inS3 = 1;
      } catch (err) {
        console.error(`upload ${id}: S3 copy failed:`, s3Error(err).message);
      }
    }
    const row: FileRow = {
      id, name: displayName(file.name), stored, type: v.type, size: head.length,
      sha256: createHash('sha256').update(head).digest('hex'), in_s3: inS3, created_at: new Date().toISOString(),
    };
    db.query('INSERT INTO files VALUES ($id, $name, $stored, $type, $size, $sha256, $in_s3, $created_at)').run({ ...row });
    return done(c, 201, `stored ${row.name}${s3 && !inS3 ? ' (S3 copy failed)' : ''}`, { id });
  });

  app.get('/files/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID_RE.test(id)) return c.json({ error: 'bad file id' }, 400);
    const row = db.query('SELECT * FROM files WHERE id = $id').get({ id }) as FileRow | null;
    if (!row || !(row.type in TYPES)) return c.json({ error: 'not found' }, 404);
    let body: Uint8Array;
    if (c.req.query('from') === 's3') {
      if (!s3 || !row.in_s3) return c.json({ error: 'no S3 copy' }, 404);
      body = new Uint8Array(await withTimeout(s3.file(`files/${row.stored}`).arrayBuffer(), 5000, 'S3 read'));
    } else {
      body = readFileSync(storedPath(uploadsDir, row.stored));
    }
    return c.body(body as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': row.type,
      'Content-Disposition': `attachment; filename="${row.name}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    });
  });

  app.onError((err, c) => {
    console.error(`${c.req.method} ${c.req.path}:`, err.message);
    return c.json({ error: 'internal error' }, 500);
  });

  return { app, db, bucket: BUCKET };
}
