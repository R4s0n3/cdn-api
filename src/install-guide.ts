import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

const PUBLIC_API_BASE_URL_PLACEHOLDER = '{{PUBLIC_API_BASE_URL}}';
const TEMPLATE_FILE_NAME = 'cdn-api-agents.md';
const MAX_TEMPLATE_BYTES = 128 * 1024;

export const INSTALL_GUIDE_PATH = '/api/install/AGENTS.md';
export const INSTALL_GUIDE_CACHE_CONTROL =
  'public, max-age=300, must-revalidate';

export type InstallGuide = {
  body: string;
  contentLength: number;
  etag: string;
};

/** Locate the bundled guide template from either the source or compiled server directory. */
function defaultTemplatePath(): string {
  return path.resolve(__dirname, '..', 'templates', TEMPLATE_FILE_NAME);
}

/** Read a bounded UTF-8 guide template and fail startup clearly if it is unavailable. */
function readTemplate(templatePath: string): string {
  let templateBuffer: Buffer;

  try {
    templateBuffer = readFileSync(templatePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load CDN integration guide template at ${templatePath}: ${reason}`,
    );
  }

  if (templateBuffer.byteLength > MAX_TEMPLATE_BYTES) {
    throw new Error(
      `CDN integration guide template exceeds the ${MAX_TEMPLATE_BYTES}-byte limit`,
    );
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(templateBuffer);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `CDN integration guide template is not valid UTF-8: ${reason}`,
    );
  }
}

/** Substitute only the supported public-origin placeholder, excluding server secrets. */
function renderTemplate(template: string, publicApiBaseUrl: string): string {
  if (!template.includes(PUBLIC_API_BASE_URL_PLACEHOLDER)) {
    throw new Error(
      `CDN integration guide template is missing ${PUBLIC_API_BASE_URL_PLACEHOLDER}`,
    );
  }

  const unknownPlaceholders = [...template.matchAll(/\{\{[^{}\r\n]+\}\}/g)]
    .map((match) => match[0])
    .filter((placeholder) => placeholder !== PUBLIC_API_BASE_URL_PLACEHOLDER);

  if (unknownPlaceholders.length > 0) {
    throw new Error(
      `CDN integration guide template contains unsupported placeholders: ${[
        ...new Set(unknownPlaceholders),
      ].join(', ')}`,
    );
  }

  return template.replaceAll(PUBLIC_API_BASE_URL_PLACEHOLDER, publicApiBaseUrl);
}

/** Render a secret-free integration guide and compute stable content metadata for HTTP caching. */
export function loadInstallGuide(
  publicApiBaseUrl: string,
  templatePath: string = defaultTemplatePath(),
): InstallGuide {
  const body = renderTemplate(readTemplate(templatePath), publicApiBaseUrl);
  const digest = createHash('sha256').update(body, 'utf8').digest('hex');

  return {
    body,
    contentLength: Buffer.byteLength(body, 'utf8'),
    etag: `"sha256-${digest}"`,
  };
}

/** Match any listed weak or strong ETag, including the wildcard validator. */
function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }

  return ifNoneMatch.split(',').some((candidate) => {
    const validator = candidate.trim();
    return validator === '*' || validator === etag || validator === `W/${etag}`;
  });
}

/** Set the guide content, cache, and validation headers consistently for GET and HEAD. */
function setGuideHeaders(response: Response, guide: InstallGuide): void {
  response.setHeader('Cache-Control', INSTALL_GUIDE_CACHE_CONTROL);
  response.setHeader('Content-Disposition', 'inline; filename="AGENTS.md"');
  response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  response.setHeader('ETag', guide.etag);
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

/** Serve the rendered guide with HEAD support and conditional ETag responses. */
export function createInstallGuideHandler(guide: InstallGuide): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.path !== INSTALL_GUIDE_PATH) {
      next();
      return;
    }

    setGuideHeaders(response, guide);

    if (matchesEtag(request.header('If-None-Match'), guide.etag)) {
      response.status(304).end();
      return;
    }

    response.setHeader('Content-Length', guide.contentLength);
    response.status(200);

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    response.end(guide.body);
  };
}

/** Redirect the short install URL to the canonical Markdown guide. */
export function redirectToInstallGuide(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (request.path !== '/api/install') {
    next();
    return;
  }

  response.redirect(308, INSTALL_GUIDE_PATH);
}
