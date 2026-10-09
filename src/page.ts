import type { FileRow } from './store.ts';
import { MAX_BYTES, TYPES } from './uploads.ts';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export function page(files: FileRow[], msg: string, s3: boolean): string {
  const rows = files
    .map(
      (f) => `<tr><td><a href="/files/${f.id}">${esc(f.name)}</a></td><td>${esc(f.type)}</td><td>${f.size}</td>` +
        `<td>${f.in_s3 ? `<a href="/files/${f.id}?from=s3">S3 copy</a>` : 'no'}</td><td>${esc(f.created_at.slice(0, 19))}Z</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>hono-files</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#333}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.3rem;text-align:left}
.msg{background:#eef6ff;padding:.5rem;border-radius:6px}small{color:#777}</style></head>
<body><h1>hono-files</h1>
<p>Bun + Hono, files in a kept <code>uploads/</code> folder, metadata in SQLite under <code>data/</code>,
and a copy of each file in SeaweedFS over S3 (${s3 ? 'connected' : 'not configured'}).</p>
${msg ? `<p class="msg">${esc(msg)}</p>` : ''}
<form method="post" action="/upload" enctype="multipart/form-data">
<input type="file" name="file" required accept="${Object.keys(TYPES).join(',')}"> <button>Upload</button>
<br><small>Up to ${MAX_BYTES / 1024 / 1024} MB: ${Object.values(TYPES).join(', ')}.</small></form>
<h2>Files</h2>
<table><tr><th>Name</th><th>Type</th><th>Bytes</th><th>S3</th><th>Uploaded</th></tr>${rows || '<tr><td colspan="5">None yet.</td></tr>'}</table>
<p><small><a href="/_zoo/health">health</a> · <a href="/_zoo/probe">probe</a> · <a href="/files">JSON</a></small></p>
</body></html>`;
}
