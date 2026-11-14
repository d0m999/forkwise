import { expect, it } from 'vitest';
import { attachmentContentUrl, openCardAttachment } from './card-attachments';

const origin = 'http://127.0.0.1:8787';

function response(status: number) {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

it('四类打开结果使用不同提示，弹窗被拦截时改为下载', async () => {
  const url = attachmentContentUrl(origin, '项目', '资产', 'inline');
  expect(url).toContain('/api/mapping/projects/%E9%A1%B9%E7%9B%AE/assets/%E8%B5%84%E4%BA%A7/content?disposition=inline');
  const missing = await openCardAttachment({ origin, projectId: 'p', assetId: 'a', fetchImpl: async () => response(404), openImpl: () => null });
  const forbidden = await openCardAttachment({ origin, projectId: 'p', assetId: 'a', fetchImpl: async () => response(403), openImpl: () => null });
  const server = await openCardAttachment({ origin, projectId: 'p', assetId: 'a', fetchImpl: async () => response(503), openImpl: () => null });
  const downloads: string[] = [];
  const blocked = await openCardAttachment({
    origin, projectId: 'p', assetId: 'a',
    fetchImpl: async () => response(200),
    openImpl: () => null,
    downloadImpl: (value) => { downloads.push(value); },
  });
  const opened = await openCardAttachment({
    origin, projectId: 'p', assetId: 'a',
    fetchImpl: async () => response(200),
    openImpl: () => ({}) as Window,
  });
  expect(missing).toEqual({ ok: false, reason: 'missing', message: '资产不存在或不属于本项目' });
  expect(forbidden).toEqual({ ok: false, reason: 'forbidden', message: '没有权限打开这个附件' });
  expect(server).toEqual({ ok: false, reason: 'server', message: '服务端暂时无法打开这个附件' });
  expect(blocked).toEqual({ ok: false, reason: 'blocked', message: '弹窗被拦截，已改为下载' });
  expect(downloads).toEqual([attachmentContentUrl(origin, 'p', 'a', 'attachment')]);
  expect(new Set([missing, forbidden, server, blocked].map(item => item.ok ? '' : item.message)).size).toBe(4);
  expect(opened).toEqual({ ok: true });
});
