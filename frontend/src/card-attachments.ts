export function attachmentContentUrl(origin: string, projectId: string, assetId: string, disposition: 'inline' | 'attachment') {
  const url = new URL(`/api/mapping/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/content`, origin);
  url.searchParams.set('disposition', disposition);
  return url.toString();
}

export type AttachmentOpenResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'corrupt' | 'forbidden' | 'server' | 'blocked' | 'rejected' | 'network' | 'download'; message: string };

export async function openCardAttachment(input: {
  origin: string;
  projectId: string;
  assetId: string;
  // 点击当时同步打开的空白标签。预检完成前不能再 window.open，否则句柄会丢。
  opened?: Window | null;
  fetchImpl?: typeof fetch;
  openImpl?: (url: string, target: string) => Window | null;
  downloadImpl?: (url: string) => void;
}): Promise<AttachmentOpenResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const inline = attachmentContentUrl(input.origin, input.projectId, input.assetId, 'inline');
  const reserve = input.opened && !input.opened.closed ? input.opened : null;
  const release = () => { if (reserve && !reserve.closed) reserve.close(); };
  let response: Response;
  try {
    response = await fetchImpl(inline, { credentials: 'same-origin' });
  } catch {
    release();
    return { ok: false, reason: 'network', message: '无法连接本机服务，附件未打开' };
  }
  // 预检只为状态码和打开方式：正文不读，避免同一份原件为一次打开被下载两遍。
  const forcedDownload = (response.headers?.get('content-disposition') ?? '').startsWith('attachment');
  await response.body?.cancel().catch(() => {});
  const rejected =
    response.status === 404 ? { ok: false as const, reason: 'missing' as const, message: '资产不存在或不属于本项目' }
    : response.status === 422 ? { ok: false as const, reason: 'corrupt' as const, message: '附件原件字节损坏，无法打开或下载' }
    : response.status === 403 ? { ok: false as const, reason: 'forbidden' as const, message: '没有权限打开这个附件' }
    : response.status >= 500 ? { ok: false as const, reason: 'server' as const, message: '服务端暂时无法打开这个附件' }
    : !response.ok ? { ok: false as const, reason: 'rejected' as const, message: `附件请求被拒绝（${response.status}）` }
    : null;
  if (rejected) {
    release();
    return rejected;
  }
  const download = attachmentContentUrl(input.origin, input.projectId, input.assetId, 'attachment');
  const startDownload = input.downloadImpl ?? downloadAttachment;
  const downloadFailed = { ok: false as const, reason: 'download' as const, message: '附件未能下载' };
  // 不能内联时沿用点击当时的空白标签导航到下载地址。预检返回后再脚本点击，这次点击的用户激活已经用完。
  if (forcedDownload) {
    if (reserve) {
      try {
        reserve.location.href = download;
        try { reserve.opener = null; } catch { /* 导航已经断开 opener 时不必再写。 */ }
      } catch {
        release();
        return downloadFailed;
      }
      return { ok: true };
    }
    try {
      startDownload(download);
    } catch {
      return downloadFailed;
    }
    return { ok: true };
  }
  if (reserve) return showInline(reserve, inline);
  const openImpl = input.openImpl ?? ((url, target) => window.open(url, target));
  // 不能带 noopener 特性：带它时 window.open 恒返回 null，"被拦截"就永远分不出来。先拿句柄再断开 opener。
  const opened = openImpl(inline, '_blank');
  if (opened) return showInline(opened);
  startDownload(download);
  return { ok: false, reason: 'blocked', message: '弹窗被拦截，已改为下载' };
}

function showInline(opened: Window, url?: string): AttachmentOpenResult {
  if (url) opened.location.href = url;
  try { opened.opener = null; } catch { /* 导航已经断开 opener 时不必再写。 */ }
  return { ok: true };
}

function downloadAttachment(url: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
