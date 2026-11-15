import { toBlob } from 'html-to-image';

export type CanvasExportVisual = { transform: string; width: number; height: number };
type Rect = { x: number; y: number; width: number; height: number };

const PADDING = 32;
const CONTENT_SELECTOR = '.react-flow__node, .canvas-frame, .canvas-frame-header, .canvas-group-outline, .canvas-connector, .connector-label';
const INTERACTION_SELECTOR = [
  '.react-flow__controls', '.react-flow__attribution', '.react-flow__selection', '.react-flow__nodesselection-rect',
  '.card-actions', '.move-handle', '.card-resize', '.text-actions', '.text-resize', '.canvas-frame-actions',
  '.frame-resize-overlay', '.canvas-group-tools', '.connector-endpoint', '.connector-entry', '.alignment-guide',
  '.image-crop-actions', '.canvas-gif-control', '.shape-text-actions', '.shape-appearance-dialog',
].join(',');

async function waitForCapture() {
  const hold = (globalThis as { __forkwiseExportHold?: () => Promise<void> }).__forkwiseExportHold;
  if (hold) await hold();
  for (let frame = 0; frame < 2; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

function contentBounds(root: HTMLElement): Rect {
  const viewport = root.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewport) throw new Error('画布尚未完成绘制，无法导出');
  const transform = new DOMMatrixReadOnly(getComputedStyle(viewport).transform === 'none' ? undefined : getComputedStyle(viewport).transform);
  const rootRect = root.getBoundingClientRect();
  const rectangles = [...root.querySelectorAll<HTMLElement>(CONTENT_SELECTOR)]
    .filter(element => !element.closest(INTERACTION_SELECTOR) && getComputedStyle(element).display !== 'none')
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
  prepare: (visual: CanvasExportVisual | null) => void,
  isCurrent: () => boolean,
): Promise<Blob> {
  const bounds = contentBounds(root);
  const width = Math.max(1, Math.ceil(bounds.width + PADDING * 2));
  const height = Math.max(1, Math.ceil(bounds.height + PADDING * 2));
  prepare({
    width,
    height,
    transform: `translate(${PADDING - bounds.x}px, ${PADDING - bounds.y}px) scale(1)`,
  });
  try {
    await waitForCapture();
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
      filter: node => !(node instanceof Element) || !node.closest(INTERACTION_SELECTOR),
    });
    if (!isCurrent()) throw new Error('导出时出现尚未保存的编辑或已保存状态已变化，已取消下载；请重新导出，项目未修改');
    if (!blob || blob.size < 8 || blob.type !== 'image/png') throw new Error('画布图像生成失败：浏览器未返回 PNG；请重试，项目未修改');
    return blob;
  } catch (error) {
    if (error instanceof Error && error.message.includes('项目')) throw error;
    throw new Error(`画布图像生成失败：${error instanceof Error ? error.message : '未知错误'}；请重试，项目未修改`, { cause: error });
  } finally {
    prepare(null);
  }
}
