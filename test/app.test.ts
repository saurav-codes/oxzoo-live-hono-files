import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { MAX_BYTES } from '../src/uploads.ts';

const PANEL = 'https://zoo-control.s1.zoo.sorv.dev';

function setup(env: Record<string, string> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'hono-app-'));
  const uploadsDir = join(base, 'uploads');
  const { app } = createApp({
    env: { ZOO_PANEL_ORIGIN: `${PANEL},http://localhost:5173`, PUBLIC_HOST: 'hono-files.s2.zoo.sorv.dev', ...env },
    dataDir: join(base, 'data'),
    uploadsDir,
    s3: null,
  });
  return { app, uploadsDir };
}

function upload(app: ReturnType<typeof setup>['app'], body: BlobPart, type: string, name = 'note.txt', headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', new File([body], name, { type }));
  return app.request('/upload', { method: 'POST', body: form, headers: { Accept: 'application/json', ...headers } });
}

describe('zoo endpoints', () => {
  test('health shape and CORS for the panel', async () => {
    const { app } = setup({ OX_RELEASE: '3f9c2a1b5d6e7f80', OX_ENV: 'production' });
    const res = await app.request('/_zoo/health', { headers: { Origin: PANEL } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(PANEL);
    expect(res.headers.get('Vary')).toBe('Origin');
    const h = await res.json();
    expect(h).toMatchObject({ name: 'hono-files', server: 's2', release: '3f9c2a1b5d6e', env: 'production' });
    expect(h.build.runtime).toStartWith('bun ');
    expect(h.build.built_at).toBeUndefined();
  });

  test('unlisted origin gets no CORS headers; preflight', async () => {
    const { app } = setup();
    const bad = await app.request('/_zoo/health', { headers: { Origin: 'https://evil.example' } });
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const pre = await app.request('/_zoo/probe', { method: 'OPTIONS', headers: { Origin: PANEL } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(pre.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    const preBad = await app.request('/_zoo/probe', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(preBad.status).toBe(204);
    expect(preBad.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  test('probe shape: local checks pass, S3 checks name the missing variable', async () => {
    const { app } = setup();
    const res = await app.request('/_zoo/probe');
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p.ok).toBe(false);
    const byId = Object.fromEntries(p.checks.map((c: { id: string }) => [c.id, c]));
    expect(byId.sqlite).toMatchObject({ ok: true, hops: ['hono-files@s2'], env: [] });
    expect(byId.keep.ok).toBe(true);
    expect(byId.s3).toMatchObject({ ok: false, error: 'S3_ENDPOINT is not set', env: ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] });
    expect(byId['s3-presign'].ok).toBe(false);
    expect(p.vars).toContainEqual({ name: 'ZOO_PANEL_ORIGIN', role: 'plain', value: `${PANEL},http://localhost:5173` });
    expect(p.vars).toContainEqual({ name: 'S3_SECRET_KEY', role: 'service', missing: true });
  });

  test('vars show only fingerprints for service keys', async () => {
    const { app } = setup({ S3_ENDPOINT: 'http://127.0.0.1:1', S3_ACCESS_KEY: 'ox', S3_SECRET_KEY: 'zoo-test-key-0123456789abcdef' });
    const text = await (await app.request('/_zoo/probe')).text();
    expect(text).not.toContain('zoo-test-key-0123456789abcdef');
    expect(JSON.parse(text).vars).toContainEqual({ name: 'S3_SECRET_KEY', role: 'service', fp: '915a' });
  });
});

describe('uploads', () => {
  test('upload, list, download', async () => {
    const { app, uploadsDir } = setup();
    const res = await upload(app, 'hello zoo', 'text/plain', '../../etc/notes.txt');
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(readdirSync(uploadsDir)).toEqual([`${id}.txt`]);
    const list = await (await app.request('/files')).json();
    expect(list.files[0]).toMatchObject({ id, name: 'notes.txt', type: 'text/plain', size: 9 });
    expect(list.files[0].stored).toBeUndefined();
    const dl = await app.request(`/files/${id}`);
    expect(await dl.text()).toBe('hello zoo');
    expect(dl.headers.get('Content-Disposition')).toBe('attachment; filename="notes.txt"');
    expect(dl.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const page = await (await app.request('/')).text();
    expect(page).toContain('notes.txt');
  });

  test('refusals', async () => {
    const { app, uploadsDir } = setup();
    expect((await upload(app, new Uint8Array(MAX_BYTES + 1).fill(97), 'text/plain')).status).toBe(413);
    expect((await upload(app, '<script>', 'text/html', 'x.html')).status).toBe(415);
    expect((await upload(app, 'not a png', 'image/png', 'x.png')).status).toBe(415);
    expect((await upload(app, 'hi', 'text/plain', 'x.txt', { Origin: 'https://evil.example' })).status).toBe(403);
    expect(readdirSync(uploadsDir)).toEqual([]);
    expect((await app.request('/files/..%2F..%2Fetc%2Fpasswd')).status).toBe(400);
    expect((await app.request(`/files/${'0'.repeat(32)}`)).status).toBe(404);
  });

  test('a form post redirects back with the message escaped', async () => {
    const { app } = setup();
    const form = new FormData();
    form.append('file', new File(['x'], '<b>.svg', { type: 'image/svg+xml' }));
    const res = await app.request('/upload', { method: 'POST', body: form });
    expect(res.status).toBe(303);
    const page = await (await app.request(res.headers.get('Location')!)).text();
    expect(page).toContain('type image/svg+xml not allowed');
    expect(page).not.toContain('<b>');
  });
});
