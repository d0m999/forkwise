import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { serve } from '@hono/node-server';

it('文件按类型决定内联或下载，图片响应保持沙箱，缺失资产返回 404', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-attachment-content-'));
  const host = openMapping(directory);
  let app: ReturnType<typeof createWorkspaceApp>;
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app = createWorkspaceApp(host, origin, () => new Response(''));
  const token = host.access.issue('human', ['*']);
  const human = host.access.authenticate(token);
  const other = host.access.issue('agent', ['other']);
  const headers = { Authorization: `Bearer ${token}` };
  const pdf = Buffer.from('%PDF-1.4\n财报').toString('base64');
  const html = Buffer.from('<p>不应内联</p>').toString('base64');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><text x="0" y="8">图</text></svg>').toString('base64');
  try {
    host.execute({ commandId: 'p', projectId: 'p', type: 'project.create', expected: null, payload: { name: '项目' } }, human);
    host.execute({ commandId: 'pdf', projectId: 'p', type: 'asset.save', expected: null, payload: { id: 'pdf', name: '财报.pdf', mime: 'application/pdf', base64: pdf, kind: 'file' } }, human);
    host.execute({ commandId: 'html', projectId: 'p', type: 'asset.save', expected: null, payload: { id: 'html', name: '页面.html', mime: 'text/html', base64: html, kind: 'file' } }, human);
    host.execute({ commandId: 'svg', projectId: 'p', type: 'asset.save', expected: null, payload: { id: 'svg', name: '图.svg', mime: 'image/svg+xml', base64: svg } }, human);
    const inline = await fetch(`${origin}/api/mapping/projects/p/assets/pdf/content`, { headers });
    expect(inline.status).toBe(200);
    expect(inline.headers.get('Content-Disposition')).toBe("inline; filename*=UTF-8''%E8%B4%A2%E6%8A%A5.pdf");
    expect(inline.headers.get('Content-Security-Policy')).toBe("default-src 'none'; style-src 'none'; img-src 'none'");
    expect(inline.headers.get('Content-Security-Policy')).not.toContain('sandbox');
    const forced = await fetch(`${origin}/api/mapping/projects/p/assets/pdf/content?disposition=attachment`, { headers });
    expect(forced.headers.get('Content-Disposition')).toContain('attachment;');
    const page = await fetch(`${origin}/api/mapping/projects/p/assets/html/content?disposition=inline`, { headers });
    expect(page.headers.get('Content-Disposition')).toContain('attachment;');
    expect(page.headers.get('Content-Security-Policy')).toContain('sandbox');
    const image = await fetch(`${origin}/api/mapping/projects/p/assets/svg/content?disposition=attachment`, { headers });
    expect(image.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox; style-src 'none'; img-src 'none'");
    expect(image.headers.get('Content-Disposition')).toBeNull();
    expect((await fetch(`${origin}/api/mapping/projects/p/assets/missing/content`, { headers })).status).toBe(404);
    expect((await fetch(`${origin}/api/mapping/projects/p/assets/pdf/content`, { headers: { Authorization: `Bearer ${other}` } })).status).toBe(403);
    expect((await fetch(`${origin}/api/mapping/projects/p/assets/pdf/content?disposition=popup`, { headers })).status).toBe(400);
  } finally {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    host.close();
  }
});
