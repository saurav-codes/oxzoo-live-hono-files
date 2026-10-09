# hono-files

Deployed with [ox](https://deploywithox.com): deploy a repo to your own server with one command, no Docker. [Docs](https://deploywithox.com/docs) · [Guide for this stack](https://deploywithox.com/docs/guides/hono-bun)

**Live demo:** https://hono-files.s2.zoo.sorv.dev

> **Role in the zoo:** project `hono-files` of [oxzoo-live](https://github.com/saurav-codes/oxzoo-live-control/blob/main/zoo/README.md#projects), deployed with [ox](https://deploywithox.com) on server s2 at https://hono-files.s2.zoo.sorv.dev. The contract it follows is [DESIGN.md](https://github.com/saurav-codes/oxzoo-live-control/blob/main/zoo/DESIGN.md).

A Bun + Hono file drop. Uploads land in a kept `uploads/` folder, metadata in
SQLite under a kept `data/` folder, and every file is mirrored to a SeaweedFS
S3 bucket that ox runs as a custom service for this project only.

## What it proves

- `[storage] keep` folders are writable while the release itself is read-only,
  really live under `$OX_DATA_DIR`, and survive a new release. The probe writes
  `data/.zoo-first-release` once and reports which release wrote it.
- A custom `[services.*]` entry built from a GitHub release tool (`weed`) starts,
  passes its health check, and hands the app working S3 credentials.
- Bun's built-in S3 client works against SeaweedFS for PUT, GET, DELETE and
  presigned PUT/GET, and an unsigned GET is refused.
- Upload handling is safe: 2 MB cap, type allowlist checked against the bytes,
  random server-side names, no path traversal, same-origin posts only,
  downloads as attachments with `nosniff`.

## ox features exercised

| Feature | Where |
| --- | --- |
| Start and install detection for Bun | `package.json` start script, `bun.lock`, `.bun-version` |
| `[app] health` | `/_zoo/health` |
| `[storage] keep` (two folders) | `data/`, `uploads/` |
| Custom service with `run`, `tool`, `health`, `memory`, `provides` | `[services.s3]` |
| GitHub release tool | `github:seaweedfs/seaweedfs@4.48` |
| Service password and `${host}`/`${port}` templating | `S3_SECRET_KEY`, `S3_ENDPOINT` |

## Variables

Provided by ox: `PORT`, `HOST`, `OX_ENV`, `OX_PROJECT`, `OX_RELEASE`,
`OX_DATA_DIR`, `PUBLIC_URL`, `PUBLIC_HOST`, and from the s3 service
`S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`.

Yours, set on the dashboard: `ZOO_PANEL_ORIGIN`, a comma separated list of
origins allowed to call `/_zoo/*` (see `.env.example`).

The probe lists the S3 variables with role `service`; as secrets they show
only a fingerprint.

## Endpoints

- `GET /` upload form and file list
- `POST /upload` multipart field `file`; JSON reply with `Accept: application/json`, else a 303 back to `/`
- `GET /files` JSON list
- `GET /files/:id` download from `uploads/`, `?from=s3` downloads the S3 copy
- `GET /_zoo/health`, `GET /_zoo/probe` the zoo contract; probe checks `sqlite`, `keep`, `s3`, `s3-presign`

## Tests

```sh
bun install
bun test
bunx tsc --noEmit -p .
```

The unit tests cover CORS, upload validation, the probe shape and the keep
folder marker logic. They run without SeaweedFS; the S3 checks then report the
missing variable.

## ox check

```
ox check . (manifest: ox.toml)

  app.start                  bun run start                                        detected:package.json
  app.health                 /_zoo/health                                         declared
  build.install              bun install --frozen-lockfile                        detected:bun.lock
  tools.bun                  1.3.14                                               detected:.bun-version
  tools.github:seaweedfs/seaweedfs 4.48                                                 declared
  services.s3                custom (only for this project)                       declared

  Provided by ox: PORT, HOST, OX_ENV, OX_PROJECT, OX_RELEASE, OX_DATA_DIR, PUBLIC_URL, PUBLIC_HOST, S3_ACCESS_KEY, S3_ENDPOINT, S3_SECRET_KEY
  Set on the dashboard before the first deploy: ZOO_PANEL_ORIGIN

Ready to deploy.
```
