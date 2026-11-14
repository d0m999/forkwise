export function attachmentContentUrl(origin: string, projectId: string, assetId: string, disposition: 'inline' | 'attachment') {
  const url = new URL(`/api/mapping/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/content`, origin);
  url.searchParams.set('disposition', disposition);
  return url.toString();
}

export type AttachmentOpenResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'forbidden' | 'server' | 'blocked' | 'rejected' | 'network'; message: string };

export async function openCardAttachment(input: {
  origin: string;
  projectId: string;
  assetId: string;
  fetchImpl?: typeof fetch;
  openImpl?: (url: string, target: string, features: string) => Window | null;
  downloadImpl?: (url: string) => void;
}): Promise<AttachmentOpenResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const inline = attachmentContentUrl(input.origin, input.projectId, input.assetId, 'inline');
  let response: Response;
  try {
    response = await fetchImpl(inline, { credentials: 'same-origin' });
  } catch {
    return { ok: false, reason: 'network', message: '无法连接本机服务，附件未打开' };
  }
  if (response.status === 404) return { ok: false, reason: 'missing', message: '资产不存在或不属于本项目' };
  if (response.status === 403) return { ok: false, reason: 'forbidden', message: '没有权限打开这个附件' };
  if (response.status >= 500) return { ok: false, reason: 'server', message: '服务端暂时无法打开这个附件' };
  if (!response.ok) return { ok: false, reason: 'rejected', message: `附件请求被拒绝（${response.status}）` };
  const openImpl = input.openImpl ?? ((url, target, features) => window.open(url, target, features));
  if (openImpl(inline, '_blank', 'noopener')) return { ok: true };
  const download = attachmentContentUrl(input.origin, input.projectId, input.assetId, 'attachment');
  (input.downloadImpl ?? downloadAttachment)(download);
  return { ok: false, reason: 'blocked', message: '弹窗被拦截，已改为下载' };
}

function downloadAttachment(url: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
