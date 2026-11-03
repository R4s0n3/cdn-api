# cdn-api

Public file CDN and upload API for [cdn.miomideal.com](https://cdn.miomideal.com). One process stores uploads and serves them. It uses its own PostgreSQL database. Previous media on the old host is not imported.

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| `GET` | `/` | no | `online` |
| `GET` | `/health` | no | `{ "status": "ok" }` |
| `GET` | `/api/upload` | no | `online` |
| `POST` | `/api/upload/single` | `X-API-Key` | one file, form field `file` |
| `POST` | `/api/upload/bulk` | `X-API-Key` | up to 5 files, form field `files` |
| `POST` | `/api/upload/asset` | `X-API-Key` | write a chosen `/assets/...` path |

Upload URLs look like `/storage/<uuid>.jpg`. Asset URLs look like `/assets/merch/shirt.png`.

```text
https://cdn.miomideal.com/storage/<uuid>.jpg
https://cdn.miomideal.com/assets/merch/shirt.png
https://cdn.miomideal.com/assets/apps/logo.png
```

`/storage` objects use `Cache-Control: public, max-age=31536000, immutable` because each upload gets a new UUID file name. `/assets` objects use a one-day cache with `stale-while-revalidate`, because those names are overwritten in place. Directory listings are disabled.

## Environment

Set these on the container. `X-API-Key` must match `CDN_API_KEY`. The comparison uses a fixed-length digest.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `postgresql://cdn:<password>@<host>:5432/cdn` |
| `CDN_API_KEY` | Long random secret |
| `SERVER_ROOT` | `/data` |
| `PORT` | `9001` |
| `NODE_ENV` | `production` |

`MAX_UPLOAD_BYTES` defaults to 52428800 (50 MiB), with a hard cap of 209715200. `CORS_ORIGINS` adds extra exact browser origins. `https://miomideal.com` and `https://*.miomideal.com` are always allowed.

Copy `.env.example` to `.env` for local runs. Prisma reads `.env` during `npm run build`.

Browser calls from miomideal.com (and its subdomains) may read responses. Other sites can still embed images. Localhost is allowed only when `NODE_ENV` is not `production`.

Upload bodies must be JPEG, PNG, GIF, WebP, AVIF, SVG, PDF, or ZIP. JPEG uploads are stored as `.jpg`. SVG is served with a locked-down content security policy. HTML placed on the volume by hand is downloaded as `application/octet-stream`. `/api/upload/single` allows 100 requests per 15 minutes, `/api/upload/bulk` allows 100 requests per hour, and the whole `/api` tree allows 100 requests per 90 seconds. File downloads are outside that API limit.

## Volume

Mount a persistent volume at `/data` and set `SERVER_ROOT=/data`.

```text
/data/storage/<uuid>.<ext>     uploads, served at /storage/<uuid>.<ext>
/data/assets/merch/shirt.png   served at /assets/merch/shirt.png
/data/assets/apps/logo.png     served at /assets/apps/logo.png
```

Asset names may use letters, numbers, `.`, `_`, and `-`. The process runs as root inside the container so files copied onto the volume stay writable. Run one replica.

```bash
docker cp ./assets/. <container-id>:/data/assets/
```

## Start command

Migrations run before the server listens:

```bash
prisma migrate deploy && node dist/main.js
```

That is what `npm start` runs. The image entrypoint does the same thing, then executes the Docker command `node dist/main.js`. Leave Coolify's start command as the image default.

## Coolify

Create a PostgreSQL database the app can reach, then create this app with build pack **Dockerfile** and Dockerfile location `/Dockerfile`.

1. **Ports Exposes:** `9001`. Leave port mappings empty.
2. **Domains:** protocol `HTTPS`, domain `cdn.miomideal.com`, port `9001`. Leave Force HTTPS on. Leave HTTP Basic Auth off so public file URLs stay reachable.
3. **Environment variables:**

   ```text
   DATABASE_URL=postgresql://cdn:<password>@<host>:5432/cdn
   CDN_API_KEY=<long-random-secret>
   SERVER_ROOT=/data
   PORT=9001
   NODE_ENV=production
   ```

   Mark `DATABASE_URL` and `CDN_API_KEY` as secrets. `PORT` must be `9001` so it matches Ports Exposes.

4. **Persistent Storage:** Add → Volume Mount → destination path `/data`.
5. **Health check:** method `GET`, scheme `http`, host `127.0.0.1`, port `9001`, path `/health`. The process listens on IPv4, so the host is `127.0.0.1`.
6. Point DNS for `cdn.miomideal.com` at the Coolify server, then deploy.

On startup the entrypoint creates `/data/assets` and `/data/storage`, applies `prisma/migrations`, then listens on `0.0.0.0:9001`. The first migration creates the `File` table.

## Upload examples

```bash
curl -sS -X POST https://cdn.miomideal.com/api/upload/single \
  -H "X-API-Key: $CDN_API_KEY" \
  -F "file=@photo.jpg"

curl -sS -X POST https://cdn.miomideal.com/api/upload/asset \
  -H "X-API-Key: $CDN_API_KEY" \
  -F "path=merch/shirt.png" \
  -F "file=@shirt.png"
```

`path` may also be `/assets/merch/shirt.png`. Uploading the same asset path again replaces the file and updates its row. The response `url` is the public path.

## Local build

Requires Node.js 22. `prisma generate` does not connect to PostgreSQL. `npm test` checks serving, cache headers, traversal, and API key checks with the database down.

```bash
cp .env.example .env
npm ci
npm test
```

To boot against a real database, put its URL in `.env` and run `npm start`.


## Panel media library

Deploy with the panel's `feat/media-manager` branch. The panel uses server-only
`UPLOAD_URL=https://cdn.miomideal.com/api/upload/` and `UPLOAD_KEY`, matching this
service's `CDN_API_KEY`. The dedicated PostgreSQL database stores only CDN metadata;
no shared application database or database-owned API key model is required.

- `GET /api/upload/files?search=&page=0` lists active metadata, newest first,
  in pages of 24. It includes existing uploads and named assets.
- `DELETE /api/upload/files/:id` deletes the stored file and soft-deletes metadata.
  It requires the same API key as uploads. Failed storage deletions can be retried.
- Uploads return public URLs which the panel resolves to absolute permalinks.
  Deleting files used by products or sponsor placements breaks their links.
  Previously cached copies may remain available until they expire.

The library lists database records, not unrelated files copied directly into storage.
The panel currently accepts JPEG, PNG, PDF, and ZIP, up to 50 MB each. Hosting/proxy body
limits must also permit the desired size.

## Optional S3 storage

Disk storage under `SERVER_ROOT` remains the default and preserves existing
`/storage/<filename>` and `/assets/...` URLs. Set `S3_ENDPOINT` and the remaining
S3 variables in `.env.example` to send new single/bulk uploads to S3 instead.
PostgreSQL, `CDN_API_KEY`, and the persistent `SERVER_ROOT` volume remain in use.
Named `/api/upload/asset` uploads continue to use the local asset tree.

S3 uploads use `<S3_KEY_PREFIX>/<cluster>/<filename>`. Without `S3_PUBLIC_BASE_URL`,
the service proxies `/storage/<cluster>/<filename>` URLs from the private bucket.
With a public base URL configured, it returns direct object URLs. Keep the bucket,
key prefix, public base URL, and salt stable so permalinks continue to work.
For an existing cluster layout, set `S3_CLUSTER_USER_ID` to the original owner's ID
and preserve `SALT_STRING` and the API key; otherwise new uploads use `cdn` as the
cluster owner. Existing S3 deletion targets are derived from their stored URL,
not recomputed from the current key or owner ID.

`GET /health/live` is available in both modes. In S3 mode, `/health/ready` checks
PostgreSQL and the configured bucket; `/api/install` serves the integration guide.
The Docker entrypoint applies the PostgreSQL migrations before starting the API.
Switching from an older MySQL-backed version requires migrating its file metadata
to PostgreSQL separately; this branch does not migrate a legacy database in place.

Run `npm run check` for the build, TypeScript checks, S3/media unit tests, and the
upstream HTTP compatibility tests.


## Proxy, readiness, and S3 failure handling

`TRUST_PROXY` defaults to `0`, so client-supplied forwarding headers are ignored.
For Coolify behind one reverse proxy, set `TRUST_PROXY=1` and expose the service
only through that proxy: do not publish port 9001 directly to the internet.
Use the exact verified hop count if your deployment has more proxies; `true` is
not accepted. This deployment setting controls client IPs used for rate limits.
S3 proxy downloads are limited to 300 requests per minute per client IP.

S3 readiness now checks the staging directory with a real temporary write. At
most one database probe remains in flight even after a readiness response times
out. On startup, UUID-named staged files older than 24 hours are removed; recent
uploads, unrelated files, and symlinks are preserved.

Transient S3 PUT failures retry up to `S3_MAX_ATTEMPTS`, reopening the file stream
for each attempt. Upload rollback deletion gets three bounded attempts. Exhausted
rollback failures and uncertain metadata commits still log object keys with
`Storage reconciliation required`: operators must reconcile those keys against
PostgreSQL before deleting them. There is no durable background reconciliation queue.
The reference client rejects cleartext remote HTTP origins; loopback development
origins remain supported. Conditional S3 requests use ETags/dates to avoid downloading
unchanged files, and an ambiguous HEAD 404 checks bucket health before returning 404.


## Private client files and download shares

New uploads through the panel Media library are private by default. The panel
first checks `/api/upload/capabilities`, then uploads with the authenticated
`X-Upload-Visibility: private` header. Private single/bulk uploads are stored under
`SERVER_ROOT/private`, outside the public storage and asset roots. This remains
true in S3 mode, so private client bytes are never placed in a public bucket.
Keep the CDN's `/data` volume persistent and size it for client files.

Public website and sponsor upload integrations keep their existing behavior.
Legacy File rows are marked public by the additive migration to avoid breaking
existing websites. The panel shows this distinction and offers an explicit
**Make private** action: it copies the selected public origin file into the private
area, removes the public origin copy, then updates metadata. Private copies are
retained for retries if the metadata update fails. Existing share links for that
file need to be recreated after the revision changes. Previously cached or
downloaded copies cannot be withdrawn.

- `GET /api/upload/files/:id/download`: authenticated backend-only private reads;
  safe raster previews can request `?preview=1`. The panel checks the current
  owner session before proxying those bytes through `/api/media/:id`.
- `POST /api/upload/files/:id/private`: authenticated, explicit privacy conversion.
- `POST /api/upload/shares`: JSON `{ title, fileIds, expiresInDays }` for 1–50 files
  and 1, 7, or 30 days (default 7). The random token is returned once; only its
  SHA-256 hash is stored.
- `GET /api/upload/shares?page=0`: paginated owner metadata, 20 shares per page.
- `DELETE /api/upload/shares/:id`: revoke future access without deleting files.
- `GET /share/:token`: only the chosen filenames/sizes and current availability.
- `GET` or `HEAD /share/:token/files/:fileId`: stream that selected file as an
  attachment after checking expiry, revocation, and its snapshotted revision.

Private reads and share downloads use private/no-store cache headers. Share
requests are rate limited and server error logs redact bearer tokens. Deleted or
replaced files stop being downloadable through previous shares. Anyone holding a
share link can download until expiry or revocation; existing public source
permalinks remain accessible until explicitly moved/deleted. No upload or share
API provides anonymous storage listings, and public directories are not listed.
Public website assets can still be collected from the website displaying them;
CORS/domain checks do not make public images confidential. Shares are not an
antivirus certification, and downloaded copies cannot be recalled.

Deploy CDN main first. Its existing migration entrypoint adds `File.isPublic`,
`MediaShare`, and `MediaShareFile`. Then deploy panel main. No extra credentials
or panel schema changes are required. There is no automatic mass conversion of
existing public website/sponsor assets.
