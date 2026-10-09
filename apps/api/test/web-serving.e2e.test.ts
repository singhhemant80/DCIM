import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdcim-web-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Crapplet DCIM</title>');
  fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  ctx = await setupTestApp({ WEB_DIST_DIR: dir });
});
afterAll(async () => {
  await ctx?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('single-process mode (API serves the web app)', () => {
  it('serves index.html for app routes so deep links work', async () => {
    for (const p of ['/', '/customers', '/users?page=2']) {
      const res = await request(ctx.server).get(p);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Crapplet DCIM');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('serves hashed assets with long-lived caching and 404s missing ones', async () => {
    const res = await request(ctx.server).get('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/immutable/);
    expect((await request(ctx.server).get('/assets/missing.js')).status).toBe(404);
  });

  it('never answers API paths with the web app', async () => {
    expect((await request(ctx.server).get('/api/v1/health/live')).body.status).toBe('ok');
    const missing = await request(ctx.server).get('/api/v1/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not_found');
    expect((await request(ctx.server).get('/api/v1/customers')).status).toBe(401);
  });

  it('does not expose files outside the build directory', async () => {
    expect((await request(ctx.server).get('/../../package.json')).text).not.toContain('"name"');
    expect((await request(ctx.server).get('/%2e%2e/%2e%2e/package.json')).text).not.toContain('@crapplet');
  });
});

describe('security headers follow the transport', () => {
  it('plain-HTTP lab mode does not force https sub-requests (otherwise the UI loads blank)', async () => {
    const res = await request(ctx.server).get('/');
    // Test config runs with COOKIE_SECURE=false (non-production default).
    expect(res.headers['content-security-policy']).not.toMatch(/upgrade-insecure-requests/);
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('HTTPS deployments keep upgrade-insecure-requests and HSTS', async () => {
    const secure = await setupTestApp({ WEB_DIST_DIR: dir, NODE_ENV: 'production', COOKIE_SECURE: 'true' });
    try {
      const res = await request(secure.server).get('/');
      expect(res.headers['content-security-policy']).toMatch(/upgrade-insecure-requests/);
      expect(res.headers['strict-transport-security']).toBeTruthy();
    } finally {
      await secure.close();
    }
  });
});
