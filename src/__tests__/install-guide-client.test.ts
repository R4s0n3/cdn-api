import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { loadInstallGuide } from '../install-guide';

type UploadFile = {
  name: string;
  blob: Blob;
};

type UploadResponse = {
  message: string;
  files: Array<{
    id?: string;
    filename: string;
    originalName: string;
    size: number;
    mimetype: string;
    url: string;
  }>;
};

type ClientModule = {
  createCdnClient(options: {
    baseUrl: string;
    apiKey: string;
    fetchImpl?: typeof fetch;
  }): {
    uploadSingle(file: UploadFile): Promise<UploadResponse>;
    uploadBulk(files: readonly UploadFile[]): Promise<UploadResponse>;
  };
};

function extractClientSource(markdown: string): string {
  const match = markdown.match(
    /<!-- BEGIN TYPESCRIPT CLIENT -->\s*```ts\n([\s\S]*?)\n```\s*<!-- END TYPESCRIPT CLIENT -->/,
  );

  if (!match?.[1]) {
    throw new Error('Could not find the normative TypeScript client example');
  }

  return match[1];
}

function compileClient(source: string): ClientModule {
  const sourcePath = path.resolve(
    'src/__tests__/generated/cdn-client-example.ts',
  );
  const compilerOptions: ts.CompilerOptions = {
    esModuleInterop: true,
    lib: ['lib.es2022.d.ts'],
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noEmitOnError: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    typeRoots: [path.resolve('node_modules/@types')],
    types: ['node'],
  };
  const compilerHost = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);
  compilerHost.getSourceFile = (
    fileName,
    languageVersionOrOptions,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    if (path.resolve(fileName) === sourcePath) {
      return ts.createSourceFile(
        sourcePath,
        source,
        typeof languageVersionOrOptions === 'number'
          ? languageVersionOrOptions
          : languageVersionOrOptions.languageVersion,
        true,
        ts.ScriptKind.TS,
      );
    }

    return originalGetSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile,
    );
  };
  compilerHost.fileExists = (fileName) =>
    path.resolve(fileName) === sourcePath || ts.sys.fileExists(fileName);
  compilerHost.readFile = (fileName) =>
    path.resolve(fileName) === sourcePath ? source : ts.sys.readFile(fileName);

  let emittedJavaScript: string | undefined;
  const program = ts.createProgram([sourcePath], compilerOptions, compilerHost);
  const emitResult = program.emit(undefined, (fileName, contents) => {
    if (fileName.endsWith('.js')) {
      emittedJavaScript = contents;
    }
  });
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .concat(emitResult.diagnostics);

  if (diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
      }),
    );
  }

  if (!emittedJavaScript) {
    throw new Error('TypeScript did not emit the normative client example');
  }

  const module = { exports: {} };
  const evaluate = new Function(
    'module',
    'exports',
    `${emittedJavaScript}\nreturn module.exports;`,
  ) as (moduleValue: { exports: object }, exportsValue: object) => unknown;

  return evaluate(module, module.exports) as ClientModule;
}

function jsonResponse(files: UploadResponse['files']): Response {
  return new Response(
    JSON.stringify({
      message: 'File uploaded successfully',
      files,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

describe('normative install-guide TypeScript client', () => {
  it('compiles under strict Node 20 settings and executes correct requests', async () => {
    const markdown = loadInstallGuide('https://cdn-api.example.com').body;
    const source = extractClientSource(markdown);
    const clientModule = compileClient(source);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const requestUrl = String(input);

      if (requestUrl.endsWith('/api/upload/single')) {
        return jsonResponse([
          {
            id: 'file-id',
            filename: 'generated.jpg',
            originalName: 'photo.jpg',
            size: 3,
            mimetype: 'image/jpeg',
            url: '/storage/cluster/generated.jpg',
          },
        ]);
      }

      return jsonResponse([
        {
          filename: 'first.pdf',
          originalName: 'first.pdf',
          size: 5,
          mimetype: 'application/pdf',
          url: 'https://objects.example.com/cluster/first.pdf',
        },
        {
          filename: 'second.png',
          originalName: 'second.png',
          size: 8,
          mimetype: 'image/png',
          url: '/storage/cluster/second.png',
        },
      ]);
    });
    const client = clientModule.createCdnClient({
      baseUrl: 'https://cdn-api.example.com/',
      apiKey: 'project-specific-key',
      fetchImpl: fetchMock,
    });

    const singleResult = await client.uploadSingle({
      name: 'photo.jpg',
      blob: new Blob([Buffer.from([0xff, 0xd8, 0xff])], {
        type: 'image/jpeg',
      }),
    });
    const bulkResult = await client.uploadBulk([
      {
        name: 'first.pdf',
        blob: new Blob(['%PDF-'], { type: 'application/pdf' }),
      },
      {
        name: 'second.png',
        blob: new Blob(
          [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
          { type: 'image/png' },
        ),
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const singleCall = fetchMock.mock.calls[0];
    const bulkCall = fetchMock.mock.calls[1];
    expect(String(singleCall?.[0])).toBe(
      'https://cdn-api.example.com/api/upload/single',
    );
    expect(String(bulkCall?.[0])).toBe(
      'https://cdn-api.example.com/api/upload/bulk',
    );

    for (const call of [singleCall, bulkCall]) {
      const request = call?.[1];
      const headers = new Headers(request?.headers);
      expect(request?.method).toBe('POST');
      expect(headers.get('x-api-key')).toBe('project-specific-key');
      expect(headers.get('content-type')).toBeNull();
      expect(request?.body).toBeInstanceOf(FormData);
    }

    const singleFields = [...(singleCall?.[1]?.body as FormData).keys()];
    const bulkFields = [...(bulkCall?.[1]?.body as FormData).keys()];
    expect(singleFields).toEqual(['file']);
    const singleFile = (singleCall?.[1]?.body as FormData).get('file') as File;
    expect(singleFile.name).toBe('photo.jpg');
    expect(new Uint8Array(await singleFile.arrayBuffer())).toEqual(
      Uint8Array.from([0xff, 0xd8, 0xff]),
    );
    expect(bulkFields).toEqual(['files', 'files']);
    expect(singleResult.files[0]?.url).toBe(
      'https://cdn-api.example.com/storage/cluster/generated.jpg',
    );
    expect(bulkResult.files.map((file) => file.url)).toEqual([
      'https://objects.example.com/cluster/first.pdf',
      'https://cdn-api.example.com/storage/cluster/second.png',
    ]);
  });

  it('rejects cleartext remote origins before sending credentials', () => {
    const clientModule = compileClient(
      extractClientSource(loadInstallGuide('https://cdn-api.example.com').body),
    );
    expect(() =>
      clientModule.createCdnClient({
        baseUrl: 'http://remote.example.com',
        apiKey: 'secret',
      }),
    ).toThrow('HTTPS');
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(() =>
        clientModule.createCdnClient({
          baseUrl: `http://${host}:9001`,
          apiKey: 'secret',
        }),
      ).not.toThrow();
    }
  });

  it.each([401, 403, 413, 415, 429, 502])(
    'handles HTTP %s without exposing credentials or upstream bodies',
    async (status) => {
      const clientModule = compileClient(
        extractClientSource(
          loadInstallGuide('https://cdn-api.example.com').body,
        ),
      );
      const apiKey = 'SENTINEL_CLIENT_API_KEY';
      const upstreamSecret = 'SENTINEL_UPSTREAM_BODY_SECRET';
      const client = clientModule.createCdnClient({
        baseUrl: 'https://cdn-api.example.com',
        apiKey,
        fetchImpl: vi.fn(async () =>
          status === 403
            ? new Response(
                JSON.stringify({
                  message: `${upstreamSecret} ${apiKey}`,
                }),
                {
                  status,
                  headers: { 'Content-Type': 'application/json' },
                },
              )
            : new Response(`${upstreamSecret} ${apiKey}`, { status }),
        ),
      });

      let caught: unknown;
      try {
        await client.uploadSingle({
          name: 'photo.jpg',
          blob: new Blob([Buffer.from([0xff, 0xd8, 0xff])], {
            type: 'image/jpeg',
          }),
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        name: 'CdnApiError',
        status,
      });
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).not.toContain(apiKey);
      expect(message).not.toContain(upstreamSecret);
    },
  );

  it('rejects malformed success responses and invalid local upload inputs', async () => {
    const clientModule = compileClient(
      extractClientSource(loadInstallGuide('https://cdn-api.example.com').body),
    );
    const malformedClient = clientModule.createCdnClient({
      baseUrl: 'https://cdn-api.example.com',
      apiKey: 'project-key',
      fetchImpl: vi.fn(
        async () =>
          new Response('not-json', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          }),
      ),
    });

    await expect(
      malformedClient.uploadSingle({
        name: 'photo.jpg',
        blob: new Blob([Buffer.from([0xff, 0xd8, 0xff])], {
          type: 'image/jpeg',
        }),
      }),
    ).rejects.toMatchObject({
      message: 'CDN returned an invalid upload response',
      status: 200,
    });

    expect(() => malformedClient.uploadBulk([])).toThrow(
      'Expected between 1 and 5 upload file(s)',
    );
    expect(() =>
      malformedClient.uploadSingle({
        name: 'script.js',
        blob: new Blob(['alert(1)'], {
          type: 'text/javascript',
        }),
      }),
    ).toThrow('Unsupported media type');
  });
});
