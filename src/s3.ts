// SeaweedFS through its S3 API with Bun.S3Client. The S3 port binds
// loopback, so presigned URLs are exercised server side.
import { S3Client } from 'bun';
import { type Env } from './zoo.ts';
import { newId } from './uploads.ts';

export const BUCKET = 'hono-files';
const PRESIGN_TTL_S = 60;

export function s3FromEnv(env: Env): S3Client | null {
  if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) return null;
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    bucket: BUCKET,
    region: 'us-east-1',
  });
}

// withTimeout bounds an S3 call that takes no AbortSignal.
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`${what}: timeout after ${ms} ms`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

// Bun's S3Error says "an unexpected error has occurred" and keeps the
// reason (ConnectionRefused, SignatureDoesNotMatch, ...) in `code`.
export function s3Error(err: unknown): Error {
  const e = err as Error & { code?: string };
  return new Error(e.code && !e.message.includes(e.code) ? `${e.code}: ${e.message}` : e.message);
}

// roundTrip runs body, then always deletes key; a failed delete is reported
// unless body already failed, so the first error is the one shown.
async function roundTrip(client: S3Client, key: string, body: () => Promise<void>): Promise<void> {
  let failed = false;
  try {
    await body();
  } catch (err) {
    failed = true;
    throw s3Error(err);
  } finally {
    try {
      await client.delete(key);
      if (await client.exists(key)) throw new Error(`${key} still there after delete`);
    } catch (err) {
      if (!failed) throw s3Error(err);
      console.error(`probe cleanup of ${key} failed:`, s3Error(err).message);
    }
  }
}

export async function s3RoundTrip(client: S3Client): Promise<string> {
  const key = `zoo-probe/${newId()}.txt`;
  const value = `probe ${newId()}`;
  await roundTrip(client, key, async () => {
    await client.write(key, value, { type: 'text/plain' });
    if ((await client.file(key).text()) !== value) throw new Error('read back a different body');
  });
  return `PUT, GET, compare, DELETE in bucket ${BUCKET}`;
}

export async function presignRoundTrip(client: S3Client, signal: AbortSignal): Promise<string> {
  const key = `zoo-probe/${newId()}-presigned.txt`;
  const value = `presigned ${newId()}`;
  await roundTrip(client, key, async () => {
    const putUrl = client.presign(key, { method: 'PUT', expiresIn: PRESIGN_TTL_S });
    const put = await fetch(putUrl, { method: 'PUT', body: value, signal, redirect: 'manual' });
    if (!put.ok) throw new Error(`presigned PUT: status ${put.status}`);
    const getUrl = new URL(client.presign(key, { method: 'GET', expiresIn: PRESIGN_TTL_S }));
    const get = await fetch(getUrl, { signal, redirect: 'manual' });
    if (!get.ok) throw new Error(`presigned GET: status ${get.status}`);
    if ((await get.text()) !== value) throw new Error('presigned GET returned a different body');
    const unsigned = await fetch(getUrl.origin + getUrl.pathname, { signal, redirect: 'manual' });
    if (unsigned.ok) throw new Error('unsigned GET was allowed');
  });
  return `presigned PUT and GET (${PRESIGN_TTL_S} s), unsigned GET refused`;
}
