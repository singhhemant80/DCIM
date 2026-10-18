import { createHash } from 'node:crypto';
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { virtualizorApiKey, virtualizorClient } from './virt';

describe('Virtualizor admin API authentication', () => {
  it('signs like the Virtualizor SDK: 8 random characters + md5(pass + them)', () => {
    expect(virtualizorApiKey('secret', 'abcd1234')).toBe('abcd1234' + createHash('md5').update('secretabcd1234').digest('hex'));
    const a = virtualizorApiKey('secret');
    const b = virtualizorApiKey('secret');
    expect(a).toMatch(/^[a-z0-9]{8}[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(a.slice(8)).toBe(
      createHash('md5')
        .update('secret' + a.slice(0, 8))
        .digest('hex'),
    );
  });

  it('a redirect to another address is reported as such, not as wrong credentials', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(302, { Location: 'https://panel.example.net:4085/index.php?act=servers' });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const c = virtualizorClient({ url: `http://127.0.0.1:${port}`, verifyTls: false, apiKey: 'K', apiPass: 'P', actionsEnabled: false });
    await expect(c.test()).rejects.toThrow(/redirects to https:\/\/panel\.example\.net:4085\/index\.php; use that address/);
    server.close();
  });
});
