// The oxzoo-live contract (DESIGN.md): health, probe, vars, CORS, trace ids.
// Framework agnostic: callers adapt these to their HTTP server.
import { createHash } from 'node:crypto';

export type Env = Record<string, string | undefined>;
export type Role = 'signs' | 'verifies' | 'reference' | 'url' | 'plain' | 'service';

export const TRACE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const LOCAL_TIMEOUT_MS = 5000;
export const PROBE_TIMEOUT_MS = 20000;
export const PROBE_WAIT_MS = 5000;

export function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function fp(value: string): string {
  return sha256hex(value).slice(-4);
}

export function serverLabel(publicHost: string | undefined): string {
  for (const label of (publicHost ?? '').split('.')) {
    if (/^s[0-9]+$/.test(label)) return label;
  }
  return 'local';
}

export interface Meta {
  name: string;
  stack: string;
}

export function identity(meta: Meta, env: Env) {
  return {
    name: meta.name,
    stack: meta.stack,
    server: serverLabel(env.PUBLIC_HOST),
    release: env.OX_RELEASE ? env.OX_RELEASE.slice(0, 12) : 'unknown',
    env: env.OX_ENV || 'local',
  };
}

export interface Build {
  tag?: string;
  built_at?: string;
  runtime: string;
}

export function health(meta: Meta, env: Env, startedAt: Date, build: Build, now = new Date()) {
  return {
    ...identity(meta, env),
    uptime_s: Math.floor((now.getTime() - startedAt.getTime()) / 1000),
    started_at: startedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    build,
  };
}

export interface VarSpec {
  name: string;
  role: Role;
  peer?: string;
  // Secrets and service URLs only ever show a fingerprint.
  secret?: boolean;
}

export function describeVars(specs: VarSpec[], env: Env) {
  return specs.map((s) => {
    const value = env[s.name];
    const base: Record<string, unknown> = { name: s.name, role: s.role };
    if (s.peer) base.peer = s.peer;
    if (value === undefined || value === '') return { ...base, missing: true };
    const showValue = !s.secret && (s.role === 'url' || s.role === 'plain');
    return showValue ? { ...base, value } : { ...base, fp: fp(value) };
  });
}

// CORS for /_zoo/* (DESIGN.md CORS): exact origin echo, never `*`, never credentials.
export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((o) => o.trim()).filter(Boolean);
}

export function corsHeaders(origin: string | undefined, allowed: string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

export function preflightHeaders(origin: string | undefined, allowed: string[]): Record<string, string> {
  const h = corsHeaders(origin, allowed);
  if (!h['Access-Control-Allow-Origin']) return {};
  return {
    ...h,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  };
}

export function isZooCorsPath(path: string): boolean {
  return path === '/_zoo/health' || path === '/_zoo/probe' || path.startsWith('/_zoo/trace/') || path.startsWith('/_zoo/chain/');
}

export function validTrace(id: unknown): id is string {
  return typeof id === 'string' && TRACE_RE.test(id);
}

// Fixed window of starts per minute per process (DESIGN.md Chains).
export class RateLimit {
  private hits: number[] = [];
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit = 10, windowMs = 60000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  allow(now = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
}

export interface Check {
  id: string;
  label: string;
  env: string[];
  hops?: string[];
  timeoutMs?: number;
  // Resolves with a detail line, rejects with the failure.
  run: (signal: AbortSignal) => Promise<string | void>;
}

export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  ms: number;
  detail?: string;
  error?: string;
  env: string[];
  hops: string[];
}

// Error text without any secret value in it, cut to a sane length.
export function cleanError(err: unknown, secrets: string[]): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const s of secrets) if (s && s.length >= 4) msg = msg.split(s).join('[redacted]');
  return msg.slice(0, 300) || 'failed';
}

function timeout(ms: number, ac: AbortController): Promise<never> {
  return new Promise((_, reject) => {
    const t = setTimeout(() => {
      ac.abort();
      reject(new Error(`timeout after ${ms} ms`));
    }, ms);
    ac.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
  });
}

export async function runCheck(c: Check, env: Env, hop: string, secrets: string[]): Promise<CheckResult> {
  const base = { id: c.id, label: c.label, env: c.env, hops: c.hops ?? [hop] };
  const missing = c.env.find((k) => !env[k]);
  if (missing) return { ...base, ok: false, ms: 0, error: `${missing} is not set` };
  const ms = c.timeoutMs ?? LOCAL_TIMEOUT_MS;
  const ac = new AbortController();
  const t0 = performance.now();
  try {
    const detail = await Promise.race([c.run(ac.signal), timeout(ms, ac)]);
    const r: CheckResult = { ...base, ok: true, ms: Math.round(performance.now() - t0) };
    if (detail) r.detail = detail;
    return r;
  } catch (err) {
    return { ...base, ok: false, ms: Math.round(performance.now() - t0), error: cleanError(err, secrets) };
  } finally {
    ac.abort();
  }
}

// One probe at a time per process; a second waits up to 5 s, then 429.
export class Prober {
  private locked = false;
  private released: Promise<void> = Promise.resolve();
  private release: () => void = () => {};

  private async acquire(waitMs: number): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    while (this.locked) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.released, new Promise<void>((r) => (timer = setTimeout(r, left)))]);
      clearTimeout(timer);
    }
    this.locked = true;
    this.released = new Promise<void>((r) => (this.release = r));
    return true;
  }

  async probe(
    meta: Meta,
    env: Env,
    checks: Check[],
    vars: VarSpec[],
    waitMs = PROBE_WAIT_MS,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!(await this.acquire(waitMs))) return { status: 429, body: { error: 'probe busy' } };
    try {
      const id = identity(meta, env);
      const hop = `${meta.name}@${id.server}`;
      const secrets = vars.filter((v) => v.secret).map((v) => env[v.name] ?? '');
      const at = new Date();
      const t0 = performance.now();
      const results = await Promise.all(checks.map((c) => runCheck(c, env, hop, secrets)));
      return {
        status: 200,
        body: {
          ...id,
          ok: results.every((r) => r.ok),
          ms: Math.round(performance.now() - t0),
          at: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
          checks: results,
          vars: describeVars(vars, env),
        },
      };
    } finally {
      this.locked = false;
      this.release();
    }
  }
}
