import { expect, it } from 'vitest';
import { attachmentContentUrl, openCardAttachment } from './card-attachments';

const origin = 'http://127.0.0.1:8787';

function response(status: number, extra: { body?: { cancel: () => Promise<void> }; disposition?: string } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => (name === 'content-disposition' ? extra.disposition ?? null : null) },
    ...(extra.body ? { body: extra.body } : {}),
  } as unknown as Response;
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
  expect(missing).toEqual({ ok: false, reason: 'missing', message: '资产不存在或不属于本项目' });
  expect(forbidden).toEqual({ ok: false, reason: 'forbidden', message: '没有权限打开这个附件' });
  expect(server).toEqual({ ok: false, reason: 'server', message: '服务端暂时无法打开这个附件' });
  expect(blocked).toEqual({ ok: false, reason: 'blocked', message: '弹窗被拦截，已改为下载' });
  expect(downloads).toEqual([attachmentContentUrl(origin, 'p', 'a', 'attachment')]);
  expect(new Set([missing, forbidden, server, blocked].map(item => item.ok ? '' : item.message)).size).toBe(4);
});

it('拿到窗口时直接打开，不触发下载，并断开新窗口的 opener', async () => {
  const downloads: string[] = [];
  const opened = { opener: {} as Window | null } as unknown as Window;
  const result = await openCardAttachment({
    origin, projectId: 'p', assetId: 'a',
    fetchImpl: async () => response(200),
    openImpl: () => opened,
    downloadImpl: (value) => { downloads.push(value); },
  });
  expect(result).toEqual({ ok: true });
  expect(opened.opener).toBeNull();
  expect(downloads).toEqual([]);
});

it('预检只取状态码，不读取整份原件', async () => {
  let canceled = false;
  const result = await openCardAttachment({
    origin, projectId: 'p', assetId: 'a',
    fetchImpl: async () => response(200, { body: { cancel: async () => { canceled = true; } } }),
    openImpl: () => null,
    downloadImpl: () => {},
  });
  expect(canceled).toBe(true);
  expect(result).toEqual({ ok: false, reason: 'blocked', message: '弹窗被拦截，已改为下载' });
});

it('点击时拿到的空白标签用来显示内联原件，不能内联时在该标签下载', async () => {
  const downloads: string[] = [];
  const inlineWindow = { closed: false, opener: {} as Window | null, location: { href: '' }, close() { this.closed = true; } };
  const inline = await openCardAttachment({
    origin, projectId: 'p', assetId: 'a', opened: inlineWindow as unknown as Window,
    fetchImpl: async () => response(200, { disposition: 'inline' }),
    openImpl: () => { throw new Error('不应再开'); },
    downloadImpl: (value) => { downloads.push(value); },
  });
  expect(inline).toEqual({ ok: true });
  expect(inlineWindow.location.href).toContain('disposition=inline');
  expect(inlineWindow.opener).toBeNull();
  expect(inlineWindow.closed).toBe(false);
  const blank = { closed: false, opener: {} as Window | null, location: { href: '' }, close() { this.closed = true; } };
  const downloaded = await openCardAttachment({
    origin, projectId: 'p', assetId: 'a', opened: blank as unknown as Window,
    fetchImpl: async () => response(200, { disposition: 'attachment; filename="a.html"' }),
    openImpl: () => { throw new Error('不应再开'); },
    downloadImpl: (value) => { downloads.push(value); },
  });
  expect(downloaded).toEqual({ ok: true });
  expect(blank.closed).toBe(false);
  expect(blank.location.href).toBe(attachmentContentUrl(origin, 'p', 'a', 'attachment'));
  expect(blank.opener).toBeNull();
  expect(downloads).toEqual([]);
});

it('下载动作失败时报告下载失败，不报成已打开', async () => {
  const failed = await openCardAttachment({
    origin, projectId: 'p', assetId: 'a',
    fetchImpl: async () => response(200, { disposition: 'attachment' }),
    downloadImpl: () => { throw new Error('下载被拒绝'); },
  });
  expect(failed).toEqual({ ok: false, reason: 'download', message: '附件未能下载' });
  const blank = {
    closed: false,
    opener: {} as Window | null,
    location: { set href(_value: string) { throw new Error('导航失败'); }, get href() { return ''; } },
    close() { this.closed = true; },
  };
  const navigated = await openCardAttachment({
    origin, projectId: 'p', assetId: 'a', opened: blank as unknown as Window,
    fetchImpl: async () => response(200, { disposition: 'attachment' }),
    downloadImpl: () => { throw new Error('不应再点'); },
  });
  expect(navigated).toEqual({ ok: false, reason: 'download', message: '附件未能下载' });
  expect(blank.closed).toBe(true);
});

it('服务端判定不能内联时直接下载，不为它开新标签', async () => {
  const downloads: string[] = [];
  let opened = false;
  const result = await openCardAttachment({
    origin, projectId: 'p', assetId: 'a',
    fetchImpl: async () => response(200, { disposition: "attachment; filename*=UTF-8''%E9%A1%B5%E9%9D%A2.html" }),
    openImpl: () => { opened = true; return null; },
    downloadImpl: (value) => { downloads.push(value); },
  });
  expect(result).toEqual({ ok: true });
  expect(opened).toBe(false);
  expect(downloads).toEqual([attachmentContentUrl(origin, 'p', 'a', 'attachment')]);
});
