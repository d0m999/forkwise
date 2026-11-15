import { toBlob } from 'html-to-image';
import {
  EXPORT_CAPTURE_EVENT,
  EXPORT_CONTENT_SELECTOR,
  EXPORT_IGNORE_SELECTOR,
  EXPORT_PADDING,
} from './canvas-export-markers';

export { exportIgnoreProps } from './canvas-export-markers';

export type CanvasExportVisual = { transform: string; width: number; height: number };
type Rect = { x: number; y: number; width: number; height: number };
type ExportCaptureDetail = { hold: (paused: Promise<void>) => void };

async function waitForCapture(root: HTMLElement) {
  let paused = Promise.resolve();
  root.dispatchEvent(new CustomEvent<ExportCaptureDetail>(EXPORT_CAPTURE_EVENT, {
    detail: { hold(next) { paused = next; } },
  }));
  await paused;
  for (let frame = 0; frame < 2; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

function contentBounds(root: HTMLElement): Rect {
  const viewport = root.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewport) throw new Error('画布尚未完成绘制，无法导出');
  const transform = new DOMMatrixReadOnly(getComputedStyle(viewport).transform === 'none' ? undefined : getComputedStyle(viewport).transform);
  const rootRect = root.getBoundingClientRect();
  const rectangles = [...root.querySelectorAll<HTMLElement>(EXPORT_CONTENT_SELECTOR)]
    .filter(element => !element.closest(EXPORT_IGNORE_SELECTOR) && getComputedStyle(element).display !== 'none')
    .map(element => {
      const rect = element.getBoundingClientRect();
      const left = (rect.left - rootRect.left - transform.e) / transform.a;
      const top = (rect.top - rootRect.top - transform.f) / transform.d;
      return { x: left, y: top, width: rect.width / transform.a, height: rect.height / transform.d };
    })
    .filter(rect => Number.isFinite(rect.x + rect.y + rect.width + rect.height) && rect.width > 0 && rect.height > 0);
  if (!rectangles.length) return { x: 0, y: 0, width: 320, height: 200 };
  const left = Math.min(...rectangles.map(rect => rect.x));
  const top = Math.min(...rectangles.map(rect => rect.y));
  const right = Math.max(...rectangles.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rectangles.map(rect => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export async function renderCanvasPng(
  root: HTMLElement,
  setExportViewport: (visual: CanvasExportVisual | null) => void,
  isCurrent: () => boolean,
): Promise<Blob> {
  const bounds = contentBounds(root);
  const width = Math.max(1, Math.ceil(bounds.width + EXPORT_PADDING * 2));
  const height = Math.max(1, Math.ceil(bounds.height + EXPORT_PADDING * 2));
  setExportViewport({
    width,
    height,
    transform: `translate(${EXPORT_PADDING - bounds.x}px, ${EXPORT_PADDING - bounds.y}px) scale(1)`,
  });
  try {
    await waitForCapture(root);
    if (!isCurrent()) throw new Error('导出时出现尚未保存的编辑或已保存状态已变化，已取消下载；请重新导出，项目未修改');
    const blob = await toBlob(root, {
      width,
      height,
      style: { width: `${width}px`, height: `${height}px` },
      backgroundColor: '#f6f7f9',
      pixelRatio: 1,
      skipFonts: true,
      includeQueryParams: true,
      fetchRequestInit: { credentials: 'same-origin' },
      filter: node => !(node instanceof Element) || !node.closest(EXPORT_IGNORE_SELECTOR),
    });
    if (!isCurrent()) throw new Error('导出时出现尚未保存的编辑或已保存状态已变化，已取消下载；请重新导出，项目未修改');
    if (!blob || blob.size < 8 || blob.type !== 'image/png') throw new Error('画布图像生成失败：浏览器未返回 PNG；请重试，项目未修改');
    return blob;
  } catch (error) {
    if (error instanceof Error && error.message.includes('项目')) throw error;
    throw new Error(`画布图像生成失败：${error instanceof Error ? error.message : '未知错误'}；请重试，项目未修改`, { cause: error });
  } finally {
    setExportViewport(null);
  }
}
