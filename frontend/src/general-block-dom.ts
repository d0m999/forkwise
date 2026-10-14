import type { Block } from '../../backend/src/mapping/contracts';
import type { InlineMark } from '../../backend/src/mapping/general-blocks';

export function nodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeName === 'BR') return '\n';
  return Array.from(node.childNodes).map(nodeText).join('');
}
export function blockText(element: HTMLElement): string {
  const value = nodeText(element);
  return element.lastChild?.nodeName === 'BR' ? value.slice(0, -1) : value;
}
export function renderBlock(block: Block): HTMLElement {
  const tag =
    block.type === 'heading'
      ? `h${block.level}`
      : block.type === 'quote'
        ? 'blockquote'
        : block.type === 'divider'
          ? 'hr'
          : 'p';
  const p = document.createElement(tag);
  p.dataset.blockId = block.id;
  p.dataset.inlineId = block.inlineId ?? crypto.randomUUID();
  p.dataset.kind = block.type;
  if (block.type === 'divider') {
    p.contentEditable = 'false';
    return p;
  }
  if (block.type === 'listItem') {
    p.dataset.listType = String(block.listType);
    if (block.listType === 'todo') p.dataset.checked = String(block.checked);
  }
  const value = block.text ?? '';
  const marks = (block.marks ?? []) as InlineMark[];
  const boundaries = [
    ...new Set([0, value.length, ...marks.flatMap((m) => [m.start, m.end])]),
  ].sort((a, b) => a - b);
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!,
      end = boundaries[i + 1]!;
    let parent: HTMLElement = p;
    for (const mark of marks.filter((m) => m.start <= start && m.end >= end)) {
      const tags: Record<InlineMark['type'], string> = {
        bold: 'strong',
        italic: 'em',
        underline: 'u',
        strikethrough: 's',
        code: 'code',
        link: 'a',
        textColor: 'span',
        highlight: 'mark',
      };
      const span = document.createElement(tags[mark.type]);
      span.dataset.mark = mark.type;
      if (mark.value) span.dataset.value = mark.value;
      if (mark.type === 'link') span.setAttribute('href', mark.value!);
      if (mark.type === 'textColor' || mark.type === 'highlight')
        span.className = `${mark.type}-${mark.value}`;
      parent.append(span);
      parent = span;
    }
    value
      .slice(start, end)
      .split('\n')
      .forEach((line, j) => {
        if (j) parent.append(document.createElement('br'));
        parent.append(document.createTextNode(line));
      });
  }
  if (!value || value.endsWith('\n')) p.append(document.createElement('br'));
  return p;
}
export function readBlock(element: HTMLElement, id: string, inlineId: string): Block {
  if (element.tagName === 'HR') return { id, type: 'divider', inlineId };
  const text = blockText(element);
  let offset = 0;
  const marks: InlineMark[] = [];
  const visit = (node: Node) => {
    const start = offset;
    if (node.nodeType === Node.TEXT_NODE || node.nodeName === 'BR') offset += nodeText(node).length;
    else Array.from(node.childNodes).forEach(visit);
    if (node instanceof HTMLElement && node.dataset.mark && offset > start) {
      marks.push({
        type: node.dataset.mark as InlineMark['type'],
        start,
        end: Math.min(offset, text.length),
        ...(node.dataset.value ? { value: node.dataset.value } : {}),
      });
    }
  };
  visit(element);
  const type = /^H[1-3]$/.test(element.tagName)
    ? 'heading'
    : element.tagName === 'BLOCKQUOTE'
      ? 'quote'
      : element.dataset.listType
        ? 'listItem'
        : 'text';
  const merged: InlineMark[] = [];
  for (const mark of marks.sort((a, b) => a.type.localeCompare(b.type) || a.start - b.start)) {
    const last = merged.at(-1);
    if (last && last.type === mark.type && last.value === mark.value && last.end === mark.start)
      last.end = mark.end;
    else if (mark.end > mark.start) merged.push(mark);
  }
  return {
    id,
    type,
    text,
    inlineId,
    ...(type === 'heading' ? { level: Number(element.tagName[1]) } : {}),
    ...(type === 'listItem'
      ? {
          listType: element.dataset.listType,
          ...(element.dataset.listType === 'todo'
            ? { checked: element.dataset.checked === 'true' }
            : {}),
        }
      : {}),
    ...(merged.length ? { marks: merged } : {}),
  };
}
export function sameBlock(a: Block, b: Block): boolean {
  const marks = (block: Block) =>
    JSON.stringify(
      ((block.marks ?? []) as InlineMark[])
        .map((m) => [m.type, m.start, m.end, m.value ?? null])
        .sort(),
    );
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) =>
    key === 'inlineId'
      ? a.inlineId === undefined || a.inlineId === b.inlineId
      : key === 'marks'
        ? marks(a) === marks(b)
        : a[key] === b[key],
  );
}
export type BlockPoint = { blockId: string; offset: number };
export function selectionPoints(
  editor: HTMLElement,
): { start: BlockPoint; end: BlockPoint } | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const point = (node: Node, offset: number): BlockPoint | null => {
    const block = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
      '[data-block-id]',
    );
    if (!block || !editor.contains(block)) return null;
    const prefix = document.createRange();
    prefix.selectNodeContents(block);
    prefix.setEnd(node, offset);
    return { blockId: block.dataset.blockId!, offset: nodeText(prefix.cloneContents()).length };
  };
  const start = point(range.startContainer, range.startOffset),
    end = point(range.endContainer, range.endOffset);
  return start && end ? { start, end } : null;
}
export function restoreSelection(editor: HTMLElement, start: BlockPoint, end = start) {
  const locate = (p: BlockPoint): [Node, number] | null => {
    const block = Array.from(editor.children).find(
      (e) => (e as HTMLElement).dataset.blockId === p.blockId,
    );
    if (!block) return null;
    const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node = walk.nextNode(),
      left = p.offset;
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const length = node.textContent?.length ?? 0;
        if (left <= length) return [node, left];
        left -= length;
      }
      if (node.nodeName === 'BR') {
        if (left === 0)
          return [
            node.parentNode!,
            Array.from(node.parentNode!.childNodes).indexOf(node as ChildNode),
          ];
        left--;
      }
      node = walk.nextNode();
    }
    return [block, block.childNodes.length];
  };
  const a = locate(start),
    b = locate(end);
  if (!a || !b) return;
  const range = document.createRange();
  range.setStart(...a);
  range.setEnd(...b);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}
export function sliceTextBlock(block: Block, start: number, end: number): Block {
  const marks = ((block.marks ?? []) as InlineMark[])
    .filter((m) => m.end > start && m.start < end)
    .map((m) => ({
      ...m,
      start: Math.max(start, m.start) - start,
      end: Math.min(end, m.end) - start,
    }));
  const { marks: ignored, ...rest } = block;
  return { ...rest, text: block.text!.slice(start, end), ...(marks.length ? { marks } : {}) };
}
