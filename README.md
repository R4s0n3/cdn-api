# CDN API

Express/TypeScript upload API backed by MySQL metadata and S3-compatible object
storage. It is configured for Hetzner Object Storage while remaining compatible
with other S3 implementations.

## What stays compatible

- `POST /api/upload/single` still accepts multipart field `file`.
- `POST /api/upload/bulk` still accepts up to five multipart fields named `files`.
- Both endpoints still require `X-API-Key` and return the existing response shape.
- With `S3_PUBLIC_BASE_URL` unset, returned URLs remain
  `/storage/<cluster>/<filename>`.
- Existing objects retain the key layout `<cluster>/<filename>`, so migrated
  database URLs do not need to change.

The API now serves `GET` and `HEAD /storage/<cluster>/<filename>` from a private
bucket. `GET` supports byte ranges and `HEAD` returns object metadata. Uploads are
staged on temporary disk, streamed to S3, and removed locally. If a metadata write
fails, the API checks whether MySQL committed it before deciding whether the S3
object is safe to remove. Ambiguous cases are retained and logged for reconciliation
because an extra object is safer than a live database row pointing to missing data.

## Local setup

Requirements:

- Node.js 20.19 or newer
- MySQL matching `prisma/schema.prisma`
- A pre-created S3 bucket and credentials

```bash
npm install
cp .env.example .env
npm run dev
```

Useful commands:

```bash
npm run build
npm run typecheck
npm test
npm run check
npm start
```

The process fails at startup with a readable error if required configuration is
missing or inconsistent.

## Downloadable integration guide

Coding agents can download a public, secret-free TypeScript integration guide
from:

- `GET /api/install/AGENTS.md` (canonical Markdown response)
- `GET /api/install` (relative permanent redirect to the canonical route)

Set `PUBLIC_API_BASE_URL` to this API's public origin. It must not contain
credentials, a path, a query, or a fragment, and production requires HTTPS. The
service uses this configured value when rendering the guide; it never derives a
public URL from request `Host` or forwarded headers.

Review the download before installing it in another repository:

```bash
mkdir -p .agents
curl --proto '=https' --tlsv1.2 --fail --show-error --silent \
  'https://cdn-api.example.com/api/install/AGENTS.md' \
  --output .agents/cdn-api.md.new
```

After reviewing `.agents/cdn-api.md.new`, move it to
`.agents/cdn-api.md`. Do not replace a repository's root `AGENTS.md`; that file
can instead direct agents doing upload, media, or storage work to read
`.agents/cdn-api.md`.

## Hetzner Object Storage configuration

Create a new, empty bucket dedicated to this API and generate S3 credentials in
the Hetzner Console. Do not reuse Coolify's backup bucket: the application
migration and rollback commands assume every object in the bucket belongs to this
API. Use the service endpoint for the bucket location, without the bucket name:

| Location | `S3_REGION` | `S3_ENDPOINT` |
| --- | --- | --- |
| Falkenstein | `fsn1` | `https://fsn1.your-objectstorage.com` |
| Nuremberg | `nbg1` | `https://nbg1.your-objectstorage.com` |
| Helsinki | `hel1` | `https://hel1.your-objectstorage.com` |

Hetzner uses Signature V4 and virtual-hosted addressing, which the AWS SDK uses
here. Keep `S3_FORCE_PATH_STYLE=false`. The credential needs these exact policy
actions:

- `s3:ListBucket` on `arn:aws:s3:::YOUR_BUCKET` (this authorizes `HeadBucket`);
- `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on
  `arn:aws:s3:::YOUR_BUCKET/*` or the configured prefix.

Use a dedicated credential and least-privilege bucket policy where possible.
Hetzner credentials otherwise have broad access to buckets in their project.

### Private bucket (recommended compatibility mode)

Leave `S3_PUBLIC_BASE_URL` empty. New uploads retain relative `/storage/...` URLs,
and this API streams private objects from S3. Existing client applications do not
need a URL-format change.

### Public bucket or CDN

Set `S3_PUBLIC_BASE_URL` to the public bucket or CDN origin, for example:

```env
S3_PUBLIC_BASE_URL=https://my-bucket.nbg1.your-objectstorage.com
```

New upload responses then contain direct absolute URLs. Existing relative URLs
continue to work through the API. This is an intentional API behavior change, so
leave the setting empty during the initial migration unless all clients can
accept it. Browser `fetch` access to a direct bucket origin also requires a
bucket CORS policy. Hetzner does not support a native custom-domain CNAME; put a
CDN or compatible reverse proxy in front instead.

Hetzner references:

- [Object Storage endpoints and limits](https://docs.hetzner.com/storage/object-storage/overview/)
- [AWS SDK configuration examples](https://docs.hetzner.com/storage/object-storage/getting-started/using-libraries/)
- [Supported S3 operations](https://docs.hetzner.com/storage/object-storage/supported-actions/)
- [Bucket CORS policies](https://docs.hetzner.com/storage/object-storage/howto-protect-objects/cors/)

## Coolify deployment

Use the repository `Dockerfile` build pack and keep both `PORT` and Coolify's
**Port Exposes** value at `9001`. If you intentionally change the port, update both
values together. The container runs as a non-root user and does not require a
persistent application volume after the migration.

Important: Coolify's dashboard S3 Storage connection is used for Coolify and
database backups. It does **not** inject or mount object storage into this
application, and its backup bucket should not be reused as `S3_BUCKET`. Add all
variables from `.env.example` to this application's Environment Variables page.

Set these as runtime variables, not build variables:

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=9001
TRUST_PROXY=1
PUBLIC_API_BASE_URL=https://cdn-api.example.com
DATABASE_URL=...
SALT_STRING=...
S3_ENDPOINT=https://nbg1.your-objectstorage.com
S3_REGION=nbg1
S3_BUCKET=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=false
S3_KEY_PREFIX=
S3_PUBLIC_BASE_URL=
```

In Coolify's Normal view, disable **Build Variable** and keep **Runtime Variable**
enabled for every value above. Lock the access key, secret key, database URL, and
salt as secrets. Enable **Literal** for any value containing `$` (especially an
existing salt, secret, or database password) so Coolify does not interpolate it.
The exact legacy `SALT_STRING` must survive unchanged.

Health endpoints:

- `GET /health/live` checks only the Node process.
- `GET /health/ready` verifies both MySQL and the configured S3 bucket and is used
  by the Docker/Coolify healthcheck.

After deployment, `/health/ready` must return HTTP 200 before testing uploads.
Coolify documents application variables and health checks here:

- [Environment variables](https://coolify.io/docs/knowledge-base/environment-variables)
- [Health checks](https://coolify.io/docs/knowledge-base/health-checks)
- [Coolify S3 backup storage](https://coolify.io/docs/knowledge-base/s3/introduction)

## Migrating existing files

The safe cutover depends on preserving two things:

1. Keep the exact current `SALT_STRING`. Changing it changes the cluster assigned
   to future uploads.
2. Copy the directory contents into S3 with each existing
   `<cluster>/<filename>` path unchanged.

The migration source must be the directory that directly contains the 12-character
cluster directories. If `S3_KEY_PREFIX` is empty, an AWS CLI migration looks like:

```bash
aws configure --profile hetzner-cdn
aws configure set s3.addressing_style virtual --profile hetzner-cdn

aws s3 sync /path/to/current/storage/ s3://YOUR_BUCKET/ \
  --endpoint-url https://nbg1.your-objectstorage.com \
  --region nbg1 \
  --profile hetzner-cdn \
  --dryrun

aws s3 sync /path/to/current/storage/ s3://YOUR_BUCKET/ \
  --endpoint-url https://nbg1.your-objectstorage.com \
  --region nbg1 \
  --profile hetzner-cdn

aws s3 ls s3://YOUR_BUCKET/ \
  --recursive \
  --summarize \
  --endpoint-url https://nbg1.your-objectstorage.com \
  --region nbg1 \
  --profile hetzner-cdn

# After the final sync, this should print no planned copies.
aws s3 sync /path/to/current/storage/ s3://YOUR_BUCKET/ \
  --endpoint-url https://nbg1.your-objectstorage.com \
  --region nbg1 \
  --profile hetzner-cdn \
  --size-only \
  --dryrun
```

If `S3_KEY_PREFIX=production`, sync to `s3://YOUR_BUCKET/production/` instead.
Do not use `--delete` during migration.

Recommended sequence:

1. Run the dry run and initial sync while the old API is still online.
2. Pause old uploads, run a final sync, and repeat the `--size-only --dryrun`
   command until it reports no differences.
3. Compare the local file count and byte total with the `aws s3 ls --summarize`
   totals, then deploy with the unchanged database and `SALT_STRING`.
4. While writes remain paused, confirm `/health/ready` and open several old
   `/storage/...` URLs. Then enable writes and test one new file through each
   upload endpoint.
5. Keep the old filesystem intact through a rollback window. Delete it only after
   object counts/sizes and all consuming applications have been verified.

If rollback is required after new S3-backed writes have started, pause uploads and
reverse-sync the new objects into the old filesystem **before** starting the old
image:

```bash
aws s3 sync s3://YOUR_BUCKET/ /path/to/current/storage/ \
  --endpoint-url https://nbg1.your-objectstorage.com \
  --region nbg1 \
  --profile hetzner-cdn
```

Use `s3://YOUR_BUCKET/production/` as the source when
`S3_KEY_PREFIX=production`. Do not add `--delete` in either direction.

No Prisma schema migration is required for this storage cutover.

## Operational notes

- Per-file upload limit is 50 MB; bulk accepts at most five files.
- Bulk uploads are sent to S3 sequentially to limit memory and connection usage.
- Temporary disk must accommodate the incoming request (up to roughly 250 MB)
  even though it is cleared after completion.
- If `UPLOAD_TEMP_DIR` is customized, it must be an absolute path writable by the
  non-root `node` user; `/tmp/cdn-api-uploads` is the safe default.
- Object names are UUID-based and treated as immutable, so long-lived cache
  headers are safe.
- This service deliberately keeps the bucket private by default. The obscured
  cluster prefix is compatibility metadata, not an authorization boundary.

### Panel media management

The panel uses the existing `UPLOAD_URL` (the CDN's `/api/upload/` base URL) and
`UPLOAD_KEY` on the server. Deploy the CDN and panel changes together.

- `GET /api/upload/files?search=&page=0` returns `{ files, total }`, with 24 files
  per page, newest first. Only active metadata belonging to the authenticated
  API key and its owner is included.
- `DELETE /api/upload/files/:id` permanently deletes that owner's S3 object,
  then marks its metadata deleted. Storage failures leave metadata available
  for retry. Cached public copies may persist until their cache lifetime expires.
- Uploads continue to use `POST /api/upload/single`; JPEG, PNG, and PDF files
  up to 50 MB are accepted. The panel sends each file separately and displays
  an individual result and public link.

The library lists files recorded in this CDN database, not unrelated objects
placed directly in the bucket. Existing URLs are public. Deleting files used
by products or sponsor placements can break those placements.
