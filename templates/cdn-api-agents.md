# CDN API integration guide

This file is guidance for coding agents integrating a TypeScript project with the
CDN API. Project-specific instructions take precedence. Before editing anything,
inspect the target repository and reuse its existing server framework,
configuration, error-handling, logging, and test conventions.

## Install or update this guide safely

The canonical guide URL is
`{{PUBLIC_API_BASE_URL}}/api/install/AGENTS.md`.

Download over HTTPS to a review file. Do not pipe the response into a shell and do
not overwrite a root `AGENTS.md`.

```bash
mkdir -p .agents
curl --proto '=https' --tlsv1.2 --fail --show-error --silent \
  '{{PUBLIC_API_BASE_URL}}/api/install/AGENTS.md' \
  --output .agents/cdn-api.md.new
```

Read and review `.agents/cdn-api.md.new`. Compare it with
`.agents/cdn-api.md` if that file already exists. Only after review, move it into
place:

```bash
mv .agents/cdn-api.md.new .agents/cdn-api.md
```

An existing root `AGENTS.md` can opt in without being replaced:

```md
For upload, media, CDN, or object-storage work, also read and follow
`.agents/cdn-api.md`.
```

## Required configuration and trust boundary

Configure these values through the target project's established server-only
environment mechanism:

```env
CDN_API_BASE_URL={{PUBLIC_API_BASE_URL}}
CDN_API_KEY=obtain-the-deployment-key
```

- `CDN_API_BASE_URL` is the public CDN API origin.
- `CDN_API_KEY` is a server-only secret. Use the configured deployment key for each
  application through the existing media-center dashboard or from the project
  owner.
- If no project-specific key is available, stop and request one. Never invent a
  credential, silently reuse another application's key, or commit a real key.
- Never put the key in browser code, `NEXT_PUBLIC_*`, `VITE_*`, URLs, client
  bundles, logs, analytics, error messages, or committed environment files.
- Browser uploads must go through the target application's authenticated server
  route or server action. The server, not the browser, calls this API.

## Upload contract

Use native Node.js 20 `fetch` and `FormData` from server-only TypeScript code.

| Operation | Request |
| --- | --- |
| Single upload | `POST /api/upload/single`, multipart field `file` |
| Bulk upload | `POST /api/upload/bulk`, repeated multipart field `files`, at most five files |
| Authentication | `X-API-Key` request header |
| Allowed files | JPEG (`image/jpeg`), PNG (`image/png`), PDF (`application/pdf`) |
| Size limit | 50 MiB per file |

Let `fetch` generate the multipart boundary. Never manually set the multipart
`Content-Type` header.

Both endpoints return HTTP `200` with this shape. The single-upload response
currently includes `id`; bulk items do not, so `id` is optional:

```ts
export type CdnFile = {
  id?: string;
  filename: string;
  originalName: string;
  size: number;
  mimetype: string;
  url: string;
};

export type CdnUploadResponse = {
  message: string;
  files: CdnFile[];
};
```

Returned file URLs can be relative `/storage/...` paths or absolute object/CDN
URLs. Normalize both against `CDN_API_BASE_URL` before storing or returning them
to callers.

## Reference server-only TypeScript client

Adapt names and module boundaries to the target project instead of copying a new
architectural style into it. Keep this module in a server-only location.

<!-- BEGIN TYPESCRIPT CLIENT -->
```ts
export type CdnFile = {
  id?: string;
  filename: string;
  originalName: string;
  size: number;
  mimetype: string;
  url: string;
};

export type CdnUploadResponse = {
  message: string;
  files: CdnFile[];
};

export type CdnUploadFile = {
  name: string;
  blob: Blob;
};

export type CdnClientOptions = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
};

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'application/pdf',
]);

export class CdnApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CdnApiError';
  }
}

function requireServerEnvironment(name: 'CDN_API_BASE_URL' | 'CDN_API_KEY'): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing server environment variable: ${name}`);
  }
  return value;
}

function parseApiOrigin(rawBaseUrl: string): string {
  const trimmedBaseUrl = rawBaseUrl.trim();
  const url = new URL(trimmedBaseUrl);
  if (
    !/^[a-z][a-z\d+.-]*:\/\/[^/?#\\]+\/?$/i.test(trimmedBaseUrl) ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('CDN_API_BASE_URL must be an HTTP(S) origin');
  }
  return url.origin;
}

function validateFiles(files: readonly CdnUploadFile[], maximum: number): void {
  if (files.length === 0 || files.length > maximum) {
    throw new Error(`Expected between 1 and ${maximum} upload file(s)`);
  }

  for (const file of files) {
    if (!ALLOWED_MEDIA_TYPES.has(file.blob.type)) {
      throw new Error(`Unsupported media type for ${file.name}`);
    }
    if (file.blob.size > MAX_FILE_BYTES) {
      throw new Error(`File exceeds 50 MiB: ${file.name}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseFile(value: unknown): CdnFile | undefined {
  if (
    !isRecord(value) ||
    (value.id !== undefined && typeof value.id !== 'string') ||
    typeof value.filename !== 'string' ||
    typeof value.originalName !== 'string' ||
    typeof value.size !== 'number' ||
    typeof value.mimetype !== 'string' ||
    typeof value.url !== 'string'
  ) {
    return undefined;
  }

  return {
    ...(value.id === undefined ? {} : { id: value.id }),
    filename: value.filename,
    originalName: value.originalName,
    size: value.size,
    mimetype: value.mimetype,
    url: value.url,
  };
}

function parseUploadResponse(value: unknown): CdnUploadResponse | undefined {
  if (
    !isRecord(value) ||
    typeof value.message !== 'string' ||
    !Array.isArray(value.files)
  ) {
    return undefined;
  }

  const files = value.files.map(parseFile);
  if (files.some((file) => file === undefined)) {
    return undefined;
  }

  return {
    message: value.message,
    files: files as CdnFile[],
  };
}

async function readResponse(response: Response): Promise<CdnUploadResponse> {
  const isJson = response.headers
    .get('content-type')
    ?.toLowerCase()
    .includes('application/json');
  let payload: unknown;

  if (isJson) {
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
  } else {
    await response.text();
  }

  if (!response.ok) {
    const safeMessages: Partial<Record<number, string>> = {
      401: 'CDN API key is missing',
      403: 'CDN API key is invalid or unauthorized',
      413: 'CDN rejected a file that is too large',
      415: 'CDN rejected an unsupported file',
      429: 'CDN upload rate limit exceeded',
      502: 'CDN object storage is temporarily unavailable',
    };
    throw new CdnApiError(
      response.status,
      safeMessages[response.status] ??
        `CDN upload failed with status ${response.status}`,
    );
  }

  const uploadResponse = parseUploadResponse(payload);
  if (!uploadResponse) {
    throw new CdnApiError(
      response.status,
      'CDN returned an invalid upload response',
    );
  }

  return uploadResponse;
}

export function createCdnClient(options: CdnClientOptions) {
  const baseUrl = parseApiOrigin(options.baseUrl);
  const apiKey = options.apiKey.trim();
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!apiKey) {
    throw new Error('CDN_API_KEY must not be empty');
  }

  async function upload(
    path: '/api/upload/single' | '/api/upload/bulk',
    fieldName: 'file' | 'files',
    files: readonly CdnUploadFile[],
  ): Promise<CdnUploadResponse> {
    const form = new FormData();
    for (const file of files) {
      form.append(fieldName, file.blob, file.name);
    }

    const response = await fetchImpl(new URL(path, `${baseUrl}/`), {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
      },
      body: form,
    });
    const result = await readResponse(response);

    return {
      ...result,
      files: result.files.map((file) => ({
        ...file,
        url: new URL(file.url, `${baseUrl}/`).toString(),
      })),
    };
  }

  return {
    uploadSingle(file: CdnUploadFile): Promise<CdnUploadResponse> {
      validateFiles([file], 1);
      return upload('/api/upload/single', 'file', [file]);
    },

    uploadBulk(files: readonly CdnUploadFile[]): Promise<CdnUploadResponse> {
      validateFiles(files, 5);
      return upload('/api/upload/bulk', 'files', files);
    },
  };
}

export function createCdnClientFromEnvironment() {
  return createCdnClient({
    baseUrl: requireServerEnvironment('CDN_API_BASE_URL'),
    apiKey: requireServerEnvironment('CDN_API_KEY'),
  });
}
```
<!-- END TYPESCRIPT CLIENT -->

Do not log the request headers or the options passed to `createCdnClient`.
Translate `CdnApiError` through the target project's normal server error boundary.
Handle at least:

- `401`: key missing;
- `403`: key invalid, revoked, or not authorized;
- `413`: file too large;
- `415`: unsupported or mismatched file content;
- `429`: rate limited; apply the project's bounded retry/backoff policy rather
  than retrying indefinitely;
- `502`: object storage temporarily unavailable.

For non-JSON or malformed responses, return a generic project-appropriate error.
Do not include the API key, request headers, or full upstream response body in
logs or user-facing errors.

## Integration checklist

1. Inspect the project and choose its existing server route, server action, or
   backend service boundary.
2. Add server-only configuration validation for `CDN_API_BASE_URL` and
   `CDN_API_KEY`.
3. Add the small client using native Node.js 20 APIs and the exact request
   contract above.
4. Keep browser requests behind the application's server boundary and apply its
   existing authentication, authorization, and upload limits there.
5. Normalize both relative and absolute returned URLs.
6. Add tests for endpoint and field names, `X-API-Key`, absence of a manual
   multipart `Content-Type`, response parsing, URL normalization, supported
   errors, and secret-safe failures.
