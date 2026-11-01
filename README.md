# cdn-api

Public file CDN and upload API for [cdn.miomideal.com](https://cdn.miomideal.com). It replaces the hand-run nginx host: the same process stores uploads and serves them.

Uploads stay compatible with the existing API.

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| `GET` | `/` | no | `online` |
| `GET` | `/health` | no | `{ "status": "ok" }` |
| `GET` | `/api/upload` | no | `online` |
| `POST` | `/api/upload/single` | `X-API-Key` | one file, form field `file` |
| `POST` | `/api/upload/bulk` | `X-API-Key` | up to 5 files, form field `files` |
| `POST` | `/api/upload/asset` | `X-API-Key` | write a chosen `/assets/...` path |

A single upload still responds with a URL like `/storage/<12-char-hash>/<uuid>.jpg`. That path is now served by this process:

```text
https://cdn.miomideal.com/storage/<hash>/<uuid>.jpg
https://cdn.miomideal.com/assets/merch/shirt.png
https://cdn.miomideal.com/assets/apps/logo.png
```

`/storage` objects use `Cache-Control: public, max-age=31536000, immutable` because the file name is a new UUID on every upload. `/assets` objects use a one-day cache with `stale-while-revalidate`, because those names are overwritten in place. Directory listings are not served.

## Environment

Callers authenticate with the `X-API-Key` header. The value must match an `ApiKey.key` row in the shared MySQL database (the same NextAuth-style tables used by media-handler). The key's user is stored on the file row. This process expects those tables to already exist and does not migrate them.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | MySQL URL, for example `mysql://cdn:secret@mysql:3306/media` |
| `SALT_STRING` | yes | Salt for the storage hash. Keep the value already used in production. New uploads for a key land in `/storage/<hash>/...`. Changing the salt only moves future uploads; URLs that were already returned keep working. |
| `SERVER_ROOT` | yes | Absolute directory for files. Use `/data` in Coolify. |
| `PORT` | no | Listen port. Default `9001`. |
| `MAX_UPLOAD_BYTES` | no | Upload limit. Default `52428800` (50 MiB). Hard cap `209715200`. |
| `CORS_ORIGINS` | no | Extra allowed browser origins, comma-separated, exact match. `https://miomideal.com` and `https://*.miomideal.com` are always allowed. |
| `NODE_ENV` | no | Set to `production` in the image. |

Copy `.env.example` to `.env` for local runs. Prisma reads `.env` during `npm run build`.

Browser calls from miomideal.com (and its subdomains) are allowed to read responses. Other sites can still embed images, but `fetch` and canvas reads are blocked. Localhost is allowed only when `NODE_ENV` is not `production`.

Upload bodies must be JPEG, PNG, GIF, WebP, AVIF, SVG, or PDF. JPEG uploads are still stored as `.jpg`. SVG is served with a locked-down content security policy. HTML and other active types placed on the volume by hand are downloaded as `application/octet-stream`, not executed. Each upload is limited to 50 MiB unless `MAX_UPLOAD_BYTES` is set. `/api/upload/single` allows 100 requests per 15 minutes, `/api/upload/bulk` allows 100 requests per hour, and the whole `/api` tree allows 100 requests per 90 seconds. File downloads are not counted in that API limit.

## Volume layout

Mount a persistent volume at `/data` and set `SERVER_ROOT=/data`.

```text
/data/<hash>/<uuid>.<ext>                 new uploads, served at /storage/<hash>/<uuid>.<ext>
/data/storage/<hash>/<uuid>.<ext>         also served at the same URL (old nginx tree)
/data/assets/merch/shirt.png              served at /assets/merch/shirt.png
/data/assets/apps/logo.png                served at /assets/apps/logo.png
```

The old netcup files lived under `httpdocs/storage/<hash>/`. Either of these copies works:

- copy the hash directories to `/data/<hash>/`, or
- copy that whole `storage` directory to `/data/storage/`.

New uploads are written to `/data/<hash>/`. `/data/storage` is only a read path for a tree copied from the old host. Put merch and app files under `/data/assets/`. Names may use letters, numbers, `.`, `_`, and `-`.

The process runs as root inside the container so files copied onto the volume with `docker cp` stay writable. Run a single replica. Two containers writing the same volume will race.

To place files from the Coolify server:

```bash
docker cp ./storage/. <container-id>:/data/storage/
docker cp ./assets/. <container-id>:/data/assets/
```

## Coolify

Tested against Coolify v4 settings for a Dockerfile app. Create the resource from this repository and set the build pack to Dockerfile. That image installs `curl` for the health check and generates the Prisma client during the build.

1. **Build Pack:** Dockerfile. Dockerfile location: `/Dockerfile`.
2. **Ports Exposes:** `9001`. Leave port mappings empty. The proxy uses the domain below.
3. **Domains:** Add domain, protocol `HTTPS`, domain `cdn.miomideal.com`, port `9001`. Leave Force HTTPS on. Leave HTTP Basic Auth off so public file URLs stay reachable without a password.
4. **Environment variables:**

   ```text
   DATABASE_URL=mysql://...
   SALT_STRING=...
   SERVER_ROOT=/data
   PORT=9001
   NODE_ENV=production
   ```

   Mark `DATABASE_URL` and `SALT_STRING` as secrets. `PORT` must be `9001` so it matches Ports Exposes.

5. **Persistent Storage:** Add, choose **Volume Mount**, destination path `/data`. No source path is required. This must be exactly `SERVER_ROOT`.
6. **Health check:** method `GET`, scheme `http`, host `127.0.0.1`, port `9001`, path `/health`. A healthy process returns `200`. The process listens on IPv4, so the host is `127.0.0.1`.
7. Point DNS for `cdn.miomideal.com` at the Coolify server, then deploy. Coolify requests the certificate.
8. Optional: enable gzip on the application if you want the proxy to compress SVG and similar responses.

The image listens on `0.0.0.0:9001`, creates `/data/assets` on startup, and exits if `DATABASE_URL`, `SALT_STRING`, or `SERVER_ROOT` is missing.

## Upload examples

```bash
curl -sS -X POST https://cdn.miomideal.com/api/upload/single \
  -H "X-API-Key: $API_KEY" \
  -F "file=@photo.jpg"

curl -sS -X POST https://cdn.miomideal.com/api/upload/asset \
  -H "X-API-Key: $API_KEY" \
  -F "path=merch/shirt.png" \
  -F "file=@shirt.png"
```

`path` may also be `/assets/merch/shirt.png`. Uploading the same asset path again replaces the file and updates its database row. The response `url` is the public path.

## Local build

Requires Node.js 22 and a dummy or real `DATABASE_URL` so `prisma generate` can run. Generate does not connect to MySQL.

```bash
cp .env.example .env
npm ci
npm test
npm start
```

`npm test` compiles TypeScript and checks storage URLs, asset URLs, cache headers, traversal, and upload auth. MySQL can be down; generate only needs `DATABASE_URL` to be set, and the test script supplies a placeholder when it is missing.
