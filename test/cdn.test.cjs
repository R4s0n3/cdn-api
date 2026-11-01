const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-api-'));
process.env.DATABASE_URL = 'mysql://user:pass@127.0.0.1:1/cdn?connect_timeout=1';
process.env.SALT_STRING = 'test-salt-value';
process.env.SERVER_ROOT = root;
process.env.NODE_ENV = 'test';
process.env.PORT = '9001';

const { createApp } = require('../dist/app');
const { extensionForMime } = require('../dist/util/content-types');
const { getHashedCluster } = require('../dist/util/upload-functions');
const { clusterDirectory, resolveAssetTarget } = require('../dist/util/paths');

const cluster = '000000jb5tqu';
const storageName = 'photo.png';
const legacyName = 'legacy.png';

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

write(path.join(root, cluster, storageName), 'primary-png');
write(path.join(root, 'storage', cluster, legacyName), 'legacy-png');
write(path.join(root, 'storage', cluster, storageName), 'should-not-win');
write(path.join(root, 'assets', 'merch', 'shirt.png'), 'shirt');
write(path.join(root, 'assets', 'apps', 'logo.png'), 'logo');
write(path.join(root, 'assets', 'apps', 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
write(path.join(root, 'assets', 'apps', 'note.html'), '<script>alert(1)</script>');
write(path.join(root, 'assets', '.hidden'), 'secret');
write(path.join(root, 'secret.txt'), 'root-secret');
fs.symlinkSync('/etc/passwd', path.join(root, 'assets', 'merch', 'escape.png'));

let server;

function request(method, urlPath, headers = {}, body) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      host: '127.0.0.1',
      port: address.port,
      path: urlPath,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

before(async () => {
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
});

after(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('hash directories stay stable for the same key, user, and salt', () => {
  assert.equal(getHashedCluster('key', 'user', 'test-salt-value'), '000000jb5tqu');
  assert.equal(getHashedCluster('key', 'user'), '000000jb5tqu');
  assert.notEqual(getHashedCluster('key', 'user', 'other-salt'), '000000jb5tqu');
  assert.equal(extensionForMime('image/jpeg'), 'jpg');
  assert.equal(extensionForMime('image/png'), 'png');
  assert.equal(extensionForMime('application/pdf'), 'pdf');
});

test('uploads are written to SERVER_ROOT/<cluster>', () => {
  const dir = clusterDirectory('abcdef012345');
  assert.equal(dir, path.join(root, 'abcdef012345'));
  assert.equal(fs.statSync(dir).isDirectory(), true);
});

test('health and the legacy online route respond', async () => {
  const health = await request('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers['content-type'].startsWith('application/json'), true);
  assert.deepEqual(JSON.parse(health.body.toString()), { status: 'ok' });

  const online = await request('GET', '/');
  assert.equal(online.status, 200);
  assert.equal(online.body.toString(), 'online');
});

test('stored uploads are served from the URL the API returns', async () => {
  const res = await request('GET', `/storage/${cluster}/${storageName}`, {
    origin: 'https://miomideal.com',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), 'primary-png');
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['access-control-allow-origin'], 'https://miomideal.com');
  assert.match(res.headers.vary, /Origin/);

  const head = await request('HEAD', `/storage/${cluster}/${storageName}`);
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-type'], 'image/png');
  assert.equal(head.headers['cache-control'], 'public, max-age=31536000, immutable');

  const missing = await request('GET', `/storage/${cluster}/missing.png`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.toString(), 'Not found');
});

test('a copied nginx storage directory still resolves', async () => {
  const res = await request('GET', `/storage/${cluster}/${legacyName}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), 'legacy-png');
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
});

test('asset tree is public with a revalidating cache', async () => {
  const shirt = await request('GET', '/assets/merch/shirt.png', {
    origin: 'https://shop.miomideal.com',
  });
  assert.equal(shirt.status, 200);
  assert.equal(shirt.body.toString(), 'shirt');
  assert.equal(shirt.headers['content-type'], 'image/png');
  assert.equal(shirt.headers['cache-control'], 'public, max-age=86400, stale-while-revalidate=604800');
  assert.equal(shirt.headers['access-control-allow-origin'], 'https://shop.miomideal.com');

  const logo = await request('GET', '/assets/apps/logo.png');
  assert.equal(logo.status, 200);
  assert.equal(logo.body.toString(), 'logo');
});

test('svg is sandboxed and active content is not served inline', async () => {
  const svg = await request('GET', '/assets/apps/mark.svg');
  assert.equal(svg.status, 200);
  assert.equal(svg.headers['content-type'], 'image/svg+xml');
  assert.match(svg.headers['content-security-policy'], /sandbox/);

  const html = await request('GET', '/assets/apps/note.html');
  assert.equal(html.status, 200);
  assert.equal(html.headers['content-type'], 'application/octet-stream');
  assert.match(html.headers['content-disposition'], /attachment/);
});

test('directories, dotfiles, and paths outside the volume are not served', async () => {
  const listing = await request('GET', '/assets/merch');
  assert.equal(listing.status, 404);
  assert.equal(listing.body.includes(Buffer.from('shirt.png')), false);

  const slash = await request('GET', '/assets/merch/');
  assert.equal(slash.status, 404);

  const hidden = await request('GET', '/assets/.hidden');
  assert.equal(hidden.status, 404);

  const outside = await request('GET', '/secret.txt');
  assert.equal(outside.status, 404);

  const traversal = await request('GET', '/assets/merch/../../secret.txt');
  assert.equal(traversal.status, 404);
  assert.equal(traversal.body.toString().includes('root-secret'), false);

  const encoded = await request('GET', '/storage/%2e%2e/%2e%2e/secret.txt');
  assert.equal(encoded.status, 404);

  const symlink = await request('GET', '/assets/merch/escape.png');
  assert.equal(symlink.status, 404);
  assert.equal(symlink.body.toString().includes('root:'), false);

  const assetsViaStorage = await request('GET', '/assets/merch/shirt.png');
  assert.equal(assetsViaStorage.status, 200);
  const wrongPrefix = await request('GET', `/storage/assets/merch/shirt.png`);
  assert.equal(wrongPrefix.status, 404);
});

test('disallowed browser origins can fetch bytes but cannot read them', async () => {
  const res = await request('GET', '/assets/apps/logo.png', {
    origin: 'https://evil.example',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), 'logo');
  assert.equal(res.headers['access-control-allow-origin'], undefined);

  const lookalike = await request('GET', '/assets/apps/logo.png', {
    origin: 'https://miomideal.com.evil.com',
  });
  assert.equal(lookalike.headers['access-control-allow-origin'], undefined);

  const insecure = await request('GET', '/assets/apps/logo.png', {
    origin: 'http://miomideal.com',
  });
  assert.equal(insecure.headers['access-control-allow-origin'], undefined);
});

test('upload routes reject missing keys and do not accept other origins for CORS', async () => {
  const missing = await request('POST', '/api/upload/single');
  assert.equal(missing.status, 401);
  assert.match(missing.body.toString(), /API-KEY missing/);

  const asset = await request('POST', '/api/upload/asset');
  assert.equal(asset.status, 401);

  const allowed = await request('OPTIONS', '/api/upload/single', {
    origin: 'https://www.miomideal.com',
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'x-api-key',
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://www.miomideal.com');
  assert.match(allowed.headers['access-control-allow-headers'], /X-API-Key/i);

  const blocked = await request('POST', '/api/upload/single', {
    origin: 'https://evil.example',
  });
  assert.equal(blocked.status, 401);
  assert.equal(blocked.headers['access-control-allow-origin'], undefined);
});

test('asset paths stay inside the assets directory', () => {
  const shirt = resolveAssetTarget('merch/shirt.png');
  assert.equal(shirt.url, '/assets/merch/shirt.png');
  assert.equal(shirt.absolute, path.join(root, 'assets', 'merch', 'shirt.png'));

  const logo = resolveAssetTarget('/assets/apps/logo.png');
  assert.equal(logo.url, '/assets/apps/logo.png');
  assert.equal(resolveAssetTarget('/merch/shirt.png').url, '/assets/merch/shirt.png');

  for (const bad of ['../secret.txt', '/etc/passwd', 'merch/../../shirt.png', 'merch/shirt.html', 'merch/.hidden.png', '']) {
    assert.throws(() => resolveAssetTarget(bad));
  }
});

test('a database outage does not echo the key or driver error', async () => {
  const res = await request('POST', '/api/upload/single', {
    'x-api-key': 'super-secret-key',
    origin: 'https://miomideal.com',
  });
  assert.equal(res.status, 500);
  const text = res.body.toString();
  assert.match(text, /unknown error/i);
  assert.equal(text.includes('super-secret-key'), false);
  assert.equal(/prisma|mysql|ECONNREFUSED/i.test(text), false);
  assert.equal(res.headers['access-control-allow-origin'], 'https://miomideal.com');
});

test('file routes do not allow writes', async () => {
  const res = await request('PUT', '/assets/merch/shirt.png');
  assert.equal(res.status, 405);
});
