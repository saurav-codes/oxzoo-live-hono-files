// Persistent state: the SQLite file in data/, files in uploads/, and the
// keep-folder checks that prove both are writable and survive releases.
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { newId } from './uploads.ts';

export interface FileRow {
  id: string;
  name: string;
  stored: string;
  type: string;
  size: number;
  sha256: string;
  in_s3: number;
  created_at: string;
}

export function openDb(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'files.db'), { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  db.exec(`CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, stored TEXT NOT NULL, type TEXT NOT NULL,
    size INTEGER NOT NULL, sha256 TEXT NOT NULL, in_s3 INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
  db.exec('CREATE TABLE IF NOT EXISTS zoo_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return db;
}

export function sqliteRoundTrip(db: Database): string {
  const id = newId();
  const value = `probe-${Date.now()}`;
  db.query('INSERT INTO zoo_probe (id, value) VALUES ($id, $value)').run({ id, value });
  try {
    const row = db.query('SELECT value FROM zoo_probe WHERE id = $id').get({ id }) as { value: string } | null;
    if (row?.value !== value) throw new Error('read back a different value');
  } finally {
    db.query('DELETE FROM zoo_probe WHERE id = $id').run({ id });
  }
  const left = db.query('SELECT count(*) AS n FROM zoo_probe WHERE id = $id').get({ id }) as { n: number };
  if (left.n !== 0) throw new Error('probe row still there after delete');
  const v = db.query('SELECT sqlite_version() AS v').get() as { v: string };
  return `zoo_probe row round trip, sqlite ${v.v}`;
}

export const MARKER = '.zoo-first-release';

// releaseMarker returns the release that first wrote into dir, writing the
// current one when there is none yet. A later release reading an older id
// proves the folder outlived a deploy.
export function releaseMarker(dir: string, release: string): { first: string; created: boolean } {
  const p = join(dir, MARKER);
  if (existsSync(p)) return { first: readFileSync(p, 'utf8').trim().slice(0, 64), created: false };
  try {
    writeFileSync(p, `${release}\n`, { flag: 'wx' });
    return { first: release, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return { first: readFileSync(p, 'utf8').trim().slice(0, 64), created: false };
  }
}

export function dirRoundTrip(dir: string): void {
  const p = join(dir, `.zoo-probe-${newId()}`);
  const value = newId();
  writeFileSync(p, value, { flag: 'wx' });
  try {
    if (readFileSync(p, 'utf8') !== value) throw new Error(`${p}: read back a different value`);
  } finally {
    unlinkSync(p);
  }
}

// underDataDir says whether dir really lives in OX_DATA_DIR (ox links each
// keep path there), following the link.
export function underDataDir(dir: string, dataDir: string): boolean {
  const real = realpathSync(dir);
  const base = realpathSync(dataDir);
  return real === base || real.startsWith(base + sep);
}

export function keepCheck(dirs: Record<string, string>, markerDir: string, release: string, oxDataDir?: string): string {
  for (const [label, dir] of Object.entries(dirs)) {
    dirRoundTrip(dir);
    if (oxDataDir && !underDataDir(dir, oxDataDir)) throw new Error(`${label}/ is not under OX_DATA_DIR`);
  }
  const m = releaseMarker(markerDir, release);
  const where = oxDataDir ? 'linked under OX_DATA_DIR' : 'local folders';
  const age = m.created ? 'marker written now' : m.first === release ? 'marker from this release' : `marker from release ${m.first}, kept across deploys`;
  return `${Object.keys(dirs).join(', ')} writable, ${where}, ${age}`;
}
