import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createServer } from '../canvas/node_modules/vite/dist/node/index.js';

it('旧画布开发服务器在资源地址提供本地字体字节', async () => {
  const root = fileURLToPath(new URL('../canvas/', import.meta.url));
  const temporary = mkdtempSync(join(tmpdir(), 'forkwise-canvas-dev-'));
  let server;
  try {
    server = await createServer({
      root,
      configLoader: 'runner',
      cacheDir: join(temporary, 'vite'),
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, strictPort: true },
    });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const fonts = join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
    for (const name of ['Assistant/Assistant-Regular.woff2', 'Virgil/Virgil-Regular.woff2']) {
      const url = `${origin}/excalidraw/fonts/${name}?dev-font-check`;
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('font/woff2');
      const actual = Buffer.from(await response.arrayBuffer());
      expect(actual.subarray(0, 4).toString()).toBe('wOF2');
      expect(actual).toEqual(readFileSync(join(fonts, name)));
      const head = await fetch(url, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toBe('font/woff2');
      expect(await head.text()).toBe('');
    }
    const missing = await fetch(`${origin}/excalidraw/fonts/Assistant/missing.woff2`);
    expect(missing.status).toBe(404);
    const outside = join(temporary, 'outside.woff2');
    writeFileSync(outside, 'private test data');
    const escape = await fetch(
      `${origin}/excalidraw/fonts/${encodeURIComponent(relative(fonts, outside))}`,
    );
    expect(escape.status).toBe(404);
    expect(await escape.text()).not.toContain('private test data');
    const invalid = await fetch(`${origin}/excalidraw/fonts/%00.woff2`);
    expect(invalid.status).toBe(400);
  } finally {
    await server?.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}, 20000);
