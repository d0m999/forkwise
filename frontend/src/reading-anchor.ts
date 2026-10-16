export type ReadingAnchor = { blockId: string; offset: number; relativeY: number; mediaY?: number };
function length(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  if (node.nodeName === "BR") return 1;
  return Array.from(node.childNodes).reduce((n, child) => n + length(child), 0);
}
export function textPoint(block: Element, offset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node: Node | null;
  let last: Node = block;
  while ((node = walker.nextNode())) {
    if (node.nodeType !== Node.TEXT_NODE && node.nodeName !== "BR") continue;
    const count = length(node);
    if (offset <= count && node.nodeType === Node.TEXT_NODE) return { node, offset };
    if (offset < count && node.nodeName === "BR") return { node: node.parentNode!, offset: Array.from(node.parentNode!.childNodes).indexOf(node as ChildNode) };
    offset -= count;
    last = node;
  }
  return last.nodeType === Node.TEXT_NODE
    ? { node: last, offset: last.textContent?.length ?? 0 }
    : { node: block, offset: block.childNodes.length };
}
function rectAt(node: Node, offset: number) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  if (node.nodeType === Node.TEXT_NODE && offset < (node.textContent?.length ?? 0)) range.setEnd(node, offset + 1);
  return range.getBoundingClientRect();
}
export function captureReadingAnchor(scroller: HTMLElement): ReadingAnchor | null {
  const bounds = scroller.getBoundingClientRect();
  const blocks = Array.from(scroller.querySelectorAll<HTMLElement>("[data-block-id]"));
  const block = blocks.find(p => p.getBoundingClientRect().bottom > bounds.top + 1);
  if (!block) return null;
  const box = block.getBoundingClientRect();
  const media = block.querySelector<HTMLElement>('canvas, img:not([hidden])')?.getBoundingClientRect();
  if (media && media.height > 0 && media.top < bounds.top + 2 && media.bottom > bounds.top + 2) {
    return { blockId: block.dataset.blockId!, offset: 0, relativeY: 2, mediaY: (bounds.top + 2 - media.top) / media.height };
  }
  const range = document.caretRangeFromPoint(Math.min(box.right - 2, box.left + 8), Math.max(bounds.top + 2, box.top + 2));
  if (range && block.contains(range.startContainer)) {
    const prefix = document.createRange();
    prefix.selectNodeContents(block);
    prefix.setEnd(range.startContainer, range.startOffset);
    const rect = rectAt(range.startContainer, range.startOffset);
    return { blockId: block.dataset.blockId!, offset: length(prefix.cloneContents()), relativeY: (rect.height ? rect.top : box.top) - bounds.top };
  }
  return { blockId: block.dataset.blockId!, offset: 0, relativeY: box.top - bounds.top };
}
export function restoreReadingAnchor(scroller: HTMLElement, anchor: ReadingAnchor | null) {
  if (!anchor) return;
  const block = Array.from(scroller.querySelectorAll<HTMLElement>("[data-block-id]")).find(p => p.dataset.blockId === anchor.blockId);
  if (!block) return;
  if (anchor.mediaY !== undefined) {
    const media = block.querySelector<HTMLElement>('canvas, img:not([hidden])')?.getBoundingClientRect();
    if (media && media.height > 0) {
      scroller.scrollTop += media.top + anchor.mediaY * media.height - scroller.getBoundingClientRect().top - anchor.relativeY;
      return;
    }
  }
  const point = textPoint(block, anchor.offset);
  const rect = rectAt(point.node, point.offset);
  const top = rect.height ? rect.top : block.getBoundingClientRect().top;
  scroller.scrollTop += top - scroller.getBoundingClientRect().top - anchor.relativeY;
}
