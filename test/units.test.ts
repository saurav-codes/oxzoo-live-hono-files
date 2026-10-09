import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { s3Error } from '../src/s3.ts';
import { keepCheck, releaseMarker, underDataDir } from '../src/store.ts';
import { MAX_BYTES, displayName, newId, storedName, storedPath, validateUpload } from '../src/uploads.ts';
import { corsHeaders, fp, preflightHeaders, serverLabel, TRACE_RE } from '../src/zoo.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const text = (s: string) => new TextEncoder().encode(s);

describe('upload validation', () => {
  test('size cap', () => {
    expect(validateUpload('image/png', MAX_BYTES, PNG).ok).toBe(true);
    expect(validateUpload('image/png', MAX_BYTES + 1, PNG)).toEqual({ ok: false, status: 413, error: `file larger than ${MAX_BYTES} bytes` });
    expect(validateUpload('image/png', 0, PNG).ok).toBe(false);
  });

  test('content type allowlist, checked against the bytes', () => {
    expect(validateUpload('text/plain; charset=utf-8', 5, text('hello'))).toEqual({ ok: true, type: 'text/plain' });
    expect(validateUpload('application/json', 7, text('{"a":1}')).ok).toBe(true);
    expect(validateUpload('text/html', 5, text('<b>x')).ok).toBe(false);
    expect(validateUpload('image/svg+xml', 5, text('<svg/>')).ok).toBe(false);
    expect(validateUpload('', 5, text('hello')).ok).toBe(false);
    // A label that lies about the bytes is refused.
    expect(validateUpload('image/png', 5, text('hello'))).toMatchObject({ ok: false, status: 415 });
    expect(validateUpload('application/json', 5, text('{nope')).ok).toBe(false);
    expect(validateUpload('text/plain', 2, new Uint8Array([0xff, 0xfe])).ok).toBe(false);
  });

  test('random server-side names', () => {
    const a = newId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newId()).not.toBe(a);
    expect(storedName(a, 'image/jpeg')).toBe(`${a}.jpg`);
    expect(() => storedName('../etc', 'image/png')).toThrow();
    expect(() => storedName(a, 'text/html')).toThrow();
  });

  test('no path traversal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hono-files-'));
    const ok = `${newId()}.png`;
    expect(storedPath(dir, ok)).toBe(join(dir, ok));
    for (const bad of ['../x.png', '/etc/passwd', `${newId()}.png/../../x`, 'a.png', '..', `${newId()}.PNG`]) {
      expect(() => storedPath(dir, bad)).toThrow();
    }
  });

  test('display names drop directories and odd characters', () => {
    expect(displayName('../../etc/passwd')).toBe('passwd');
    expect(displayName('C:\\Users\\me\\cat photo.png')).toBe('cat photo.png');
    expect(displayName('a"b<c>.txt')).toBe('a_b_c_.txt');
    expect(displayName('...hidden')).toBe('hidden');
    expect(displayName('')).toBe('file');
    expect(displayName('x'.repeat(300)).length).toBe(100);
  });
});

describe('keep folders', () => {
  test('marker keeps the first release that wrote it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hono-keep-'));
    expect(releaseMarker(dir, 'rel-1')).toEqual({ first: 'rel-1', created: true });
    expect(releaseMarker(dir, 'rel-2')).toEqual({ first: 'rel-1', created: false });
  });

  test('round trip leaves nothing behind and reports the marker age', () => {
    const base = mkdtempSync(join(tmpdir(), 'hono-keep-'));
    const data = join(base, 'data');
    const uploads = join(base, 'uploads');
    mkdirSync(data);
    mkdirSync(uploads);
    expect(keepCheck({ data, uploads }, data, 'rel-1')).toContain('marker written now');
    expect(keepCheck({ data, uploads }, data, 'rel-2')).toContain('marker from release rel-1, kept across deploys');
    expect(readdirSync(uploads)).toEqual([]);
    expect(readdirSync(data)).toEqual(['.zoo-first-release']);
  });

  test('a folder must really live in OX_DATA_DIR when it is set', () => {
    const oxData = mkdtempSync(join(tmpdir(), 'hono-oxdata-'));
    const release = mkdtempSync(join(tmpdir(), 'hono-release-'));
    mkdirSync(join(oxData, 'data'));
    symlinkSync(join(oxData, 'data'), join(release, 'data'));
    mkdirSync(join(release, 'uploads'));
    expect(underDataDir(join(release, 'data'), oxData)).toBe(true);
    expect(underDataDir(join(release, 'uploads'), oxData)).toBe(false);
    expect(() => keepCheck({ data: join(release, 'data'), uploads: join(release, 'uploads') }, join(release, 'data'), 'r', oxData)).toThrow(
      'uploads/ is not under OX_DATA_DIR',
    );
  });
});

describe('zoo contract helpers', () => {
  test('fingerprint and server label', () => {
    expect(fp('zoo-test-key-0123456789abcdef')).toBe('915a');
    expect(serverLabel('hono-files.s2.zoo.sorv.dev')).toBe('s2');
    expect(serverLabel('localhost')).toBe('local');
  });

  test('trace ids', () => {
    expect(TRACE_RE.test('0f8c2a1e-1b2c-4d5e-8f90-a1b2c3d4e5f6')).toBe(true);
    expect(TRACE_RE.test('0F8C2A1E-1B2C-4D5E-8F90-A1B2C3D4E5F6')).toBe(false);
    expect(TRACE_RE.test('../../etc')).toBe(false);
  });

  test('CORS echoes only listed origins', () => {
    const allowed = ['https://zoo-control.s1.zoo.sorv.dev', 'http://localhost:5173'];
    expect(corsHeaders('http://localhost:5173', allowed)).toEqual({ 'Access-Control-Allow-Origin': 'http://localhost:5173', Vary: 'Origin' });
    expect(corsHeaders('https://evil.example', allowed)).toEqual({});
    expect(corsHeaders(undefined, allowed)).toEqual({});
    expect(preflightHeaders('https://zoo-control.s1.zoo.sorv.dev', allowed)['Access-Control-Max-Age']).toBe('600');
    expect(preflightHeaders('https://evil.example', allowed)).toEqual({});
  });
});

describe('s3 errors', () => {
  test('keep the code Bun hides', () => {
    const e = Object.assign(new Error('an unexpected error has occurred'), { code: 'ConnectionRefused' });
    expect(s3Error(e).message).toBe('ConnectionRefused: an unexpected error has occurred');
    expect(s3Error(new Error('plain')).message).toBe('plain');
  });
});
