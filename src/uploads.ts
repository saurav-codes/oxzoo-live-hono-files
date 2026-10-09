// Upload validation: size cap, content-type allowlist checked against the
// bytes, random server-side names, no path from the client ever reaches disk.
import { randomBytes } from 'node:crypto';
import { resolve, sep } from 'node:path';

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_FILES = 500;
export const ID_RE = /^[0-9a-f]{32}$/;

// Allowed types and the extension the stored file gets.
export const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/json': 'json',
};

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

// The bytes must look like the declared type; a client's label alone proves nothing.
export function sniffOk(type: string, b: Uint8Array): boolean {
  switch (type) {
    case 'image/png':
      return startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(b, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'));
    case 'image/webp':
      return startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8);
    case 'application/pdf':
      return startsWith(b, ascii('%PDF-'));
    case 'text/plain':
    case 'application/json': {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(b);
      } catch {
        return false;
      }
      if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) return false;
      if (type === 'text/plain') return true;
      try {
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

// baseType drops parameters like "; charset=utf-8".
export function baseType(type: string): string {
  return type.split(';')[0].trim().toLowerCase();
}

export type Verdict = { ok: true; type: string } | { ok: false; status: number; error: string };

export function validateUpload(declaredType: string, size: number, head: Uint8Array): Verdict {
  if (size <= 0) return { ok: false, status: 400, error: 'empty file' };
  if (size > MAX_BYTES) return { ok: false, status: 413, error: `file larger than ${MAX_BYTES} bytes` };
  const type = baseType(declaredType);
  if (!(type in TYPES)) return { ok: false, status: 415, error: `type ${type || '(none)'} not allowed` };
  if (!sniffOk(type, head)) return { ok: false, status: 415, error: `content does not look like ${type}` };
  return { ok: true, type };
}

// displayName keeps a readable label from the client's filename: no
// directories, no control or quote characters, at most 100 characters.
export function displayName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? '';
  const clean = base.replace(/[^\w .()-]/g, '_').replace(/^\.+/, '').trim().slice(0, 100);
  return clean || 'file';
}

export function newId(): string {
  return randomBytes(16).toString('hex');
}

export function storedName(id: string, type: string): string {
  if (!ID_RE.test(id) || !(type in TYPES)) throw new Error('bad id or type');
  return `${id}.${TYPES[type]}`;
}

// storedPath resolves a stored name inside dir, refusing anything that
// would land outside it.
export function storedPath(dir: string, name: string): string {
  if (!/^[0-9a-f]{32}\.[a-z]{3,4}$/.test(name)) throw new Error('bad stored name');
  const root = resolve(dir);
  const p = resolve(root, name);
  if (!p.startsWith(root + sep)) throw new Error('path escapes the uploads folder');
  return p;
}
