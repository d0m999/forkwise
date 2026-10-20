import type { Block } from '../../backend/src/mapping/contracts';
import type { InlineMark, TableCell } from '../../backend/src/mapping/general-blocks';
import { listDepth, previousListSibling } from '../../backend/src/mapping/list-structure';

const retainedBlocks = new WeakMap<HTMLElement, Block>();
const tableCellOrigins = new WeakMap<HTMLElement, { value: TableCell; rendered: Block }>();

export function applyListLayout(root: HTMLElement, blocks: Block[]): void {
  const nodes = new Map(Array.from(root.children, node => [
    (node as HTMLElement).dataset.blockId, node as HTMLElement,
  ]));
  const ordinals = new Map<string, number>();
  blocks.forEach((block, index) => {
    const node = nodes.get(block.id);
    if (!node) return;
    if (block.type === 'listItem') node.style.marginLeft = `${listDepth(blocks, block) * 24}px`;
    if (block.listType !== 'ordered') return;
    const previous = previousListSibling(blocks, index);
    const ordinal = previous >= 0 && blocks[previous]!.listType === 'ordered'
      ? (ordinals.get(blocks[previous]!.id) ?? 0) + 1 : 1;
    ordinals.set(block.id, ordinal);
    node.dataset.ordinal = String(ordinal);
  });
}

export function nodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeName === 'BR') return '\n';
  return Array.from(node.childNodes).map(nodeText).join('');
}
export function blockText(element: HTMLElement): string {
  const value = nodeText(element);
  return element.lastChild?.nodeName === 'BR' ? value.slice(0, -1) : value;
}
export function renderBlock(block: Block, projectId?: string): HTMLElement {
  const tag =
    block.type === 'table'
      ? 'div'
      : block.type === 'heading'
        ? `h${block.level}`
        : block.type === 'quote'
          ? 'blockquote'
          : block.type === 'code'
            ? 'pre'
            : block.type === 'divider'
              ? 'hr'
              : 'p';
  const p = document.createElement(tag);
  p.dataset.blockId = block.id;
  p.dataset.inlineId = block.inlineId ?? crypto.randomUUID();
  p.dataset.kind = block.type;
  if (block.type==='image'||block.type==='imageTask') {
    p.contentEditable='false';p.className='body-image';p.tabIndex=0;
    if(block.type==='image') {
      const image=document.createElement('img');const url=`/api/mapping/projects/${encodeURIComponent(projectId??'')}/assets/${encodeURIComponent(String(block.assetId))}/content`;
      if(block.mime!=='image/gif')image.src=url;
      image.alt=String(block.alt||block.name);image.width=Number(block.naturalWidth);image.height=Number(block.naturalHeight);
      image.style.width=`${Number(block.width??block.naturalWidth)}px`;image.style.maxWidth='100%';image.style.height='auto';image.style.objectFit='contain';
      image.style.aspectRatio=`${block.naturalWidth} / ${block.naturalHeight}`;
      if(block.mime!=='image/gif'){
        let failure: HTMLSpanElement | undefined;
        image.onerror=()=>{
          if(failure)return;
          failure=document.createElement('span');failure.className='image-load-error';failure.setAttribute('role','alert');
          const message=document.createElement('span');message.textContent='图片加载失败，原文件仍保留';
          const retry=document.createElement('button');retry.type='button';retry.textContent='重新加载图片';
          retry.onclick=e=>{e.stopPropagation();image.removeAttribute('src');image.src=url;};
          failure.append(message,retry);p.append(failure);
        };
        image.onload=()=>{failure?.remove();failure=undefined;};
      }
      if(block.mime==='image/gif'){
        const canvas=document.createElement('canvas');canvas.width=Number(block.naturalWidth);canvas.height=Number(block.naturalHeight);canvas.style.cssText=image.style.cssText;canvas.dataset.gifUrl=url;canvas.setAttribute('role','img');canvas.setAttribute('aria-label',image.alt);
        const button=document.createElement('button');button.type='button';button.dataset.gifToggle='';button.textContent='播放动图';button.setAttribute('aria-label','播放动图');
        p.append(canvas,button);image.hidden=true;
      }
      p.append(image);
      if(block.caption){const caption=document.createElement('span');caption.className='image-caption';caption.textContent=String(block.caption);p.append(caption);}
    }
    const task=block.type==='imageTask'?block:block.request as Block|undefined;
    if(task){
      const placeholder=document.createElement('span');placeholder.className='image-progress';placeholder.style.width=`${Number(task.width)}px`;placeholder.style.maxWidth='100%';placeholder.style.minHeight='80px';placeholder.style.aspectRatio=`${Number(task.width)} / ${Number(task.height)}`;
      placeholder.setAttribute('role','group');placeholder.setAttribute('aria-live','polite');placeholder.setAttribute('aria-label',`图片任务：${task.name}`);
      const label=document.createElement('span');label.textContent=`${task.name} — ${task.status==='failed'?task.reason:'正在处理，尚未保存'}（预留 ${task.width} × ${task.height}）`;placeholder.append(label);
      if(task.status==='queued'){const progress=document.createElement('progress');progress.setAttribute('aria-label','图片保存进度');placeholder.append(progress);}
      p.append(placeholder);
    }
    retainedBlocks.set(p,structuredClone(block));return p;
  }
  if (block.type === 'pendingImage') {
    p.contentEditable = 'false';
    p.className = 'pending-image';
    p.textContent = `${block.name} — 图片显示尚未支持，原始字节保留在正文中`;
    retainedBlocks.set(p, structuredClone(block));
    return p;
  }
  if (block.type === 'table') {
    p.contentEditable = 'false';
    p.className = 'imported-table';
    p.setAttribute('aria-label', '简单表格');
    if (block.columnWidths) p.dataset.columnWidths = JSON.stringify(block.columnWidths);
    const table = document.createElement('table'),
      body = document.createElement('tbody');
    (block.rows as TableCell[][]).forEach((row, index) => {
      const tr = document.createElement('tr');
      row.forEach((cell, column) => {
        const td = document.createElement(block.header && index === 0 ? 'th' : 'td');
        const content = renderBlock({ id: 'cell', type: 'text', ...cell });
        tableCellOrigins.set(content, {
          value: structuredClone(cell),
          rendered: readBlock(content, 'cell', 'cell'),
        });
        delete content.dataset.blockId;
        delete content.dataset.inlineId;
        content.dataset.cell = `${index},${column}`;
        content.contentEditable = 'true';
        content.setAttribute('role', 'textbox');
        content.setAttribute('aria-label', `第 ${index + 1} 行第 ${column + 1} 列`);
        content.setAttribute('aria-multiline', 'true');
        const width = (block.columnWidths as number[] | undefined)?.[column] ?? 160;
        td.style.width = `${width}px`;
        td.style.minWidth = `${width}px`;
        td.append(content);
        tr.append(td);
      });
      body.append(tr);
    });
    table.append(body);
    p.append(table);
    return p;
  }
  if (block.type === 'code') {
    p.dataset.language = String(block.language);
    p.dataset.wrap = String(block.wrap);
    p.style.whiteSpace = block.wrap ? 'pre-wrap' : 'pre';
    p.style.overflowX = 'auto';
  }
  if (block.type === 'divider') {
    p.contentEditable = 'false';
    return p;
  }
  if (block.type === 'listItem') {
    p.dataset.listType = String(block.listType);
    if (typeof block.parentId === 'string') p.dataset.parentId = block.parentId;
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
  const retained = retainedBlocks.get(element);
  if (retained) return structuredClone(retained);
  if (element.tagName === 'HR') return { id, type: 'divider', inlineId };
  if (element.dataset.kind === 'table') {
    const rows = Array.from(element.querySelectorAll('tr')).map((row) =>
      Array.from(row.querySelectorAll<HTMLElement>('[data-cell]')).map((cell) => {
        const value = readBlock(cell, 'cell', 'cell');
        const original = tableCellOrigins.get(cell);
        // DOM reading normalizes key order and adjacent marks. An unchanged
        // cell retains its full JSON; actual edits use the new inline value.
        if (original && sameBlock(original.rendered, value)) return structuredClone(original.value);
        const { text, marks } = value;
        return { text: text!, ...(marks ? { marks } : {}) };
      }),
    );
    return {
      id,
      inlineId,
      type: 'table',
      header: !!element.querySelector('th'),
      rows,
      ...(element.dataset.columnWidths
        ? { columnWidths: JSON.parse(element.dataset.columnWidths) }
        : {}),
    };
  }
  const text = blockText(element);
  if (element.dataset.kind === 'code')
    return {
      id,
      inlineId,
      type: 'code',
      text,
      language: element.dataset.language ?? '',
      wrap: element.dataset.wrap === 'true',
    };
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
          ...(element.dataset.parentId ? { parentId: element.dataset.parentId } : {}),
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
        : typeof a[key] === 'object'
          ? JSON.stringify(a[key]) === JSON.stringify(b[key])
          : a[key] === b[key],
  );
}
export type BlockPoint = { blockId: string; offset: number; cell?: string };
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
    const cell = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
      '[data-cell]',
    );
    const prefix = document.createRange();
    prefix.selectNodeContents(cell ?? block);
    prefix.setEnd(node, offset);
    return {
      blockId: block.dataset.blockId!,
      offset: nodeText(prefix.cloneContents()).length,
      ...(cell ? { cell: cell.dataset.cell! } : {}),
    };
  };
  const start = point(range.startContainer, range.startOffset),
    end = point(range.endContainer, range.endOffset);
  return start && end ? { start, end } : null;
}
export function restoreSelection(editor: HTMLElement, start: BlockPoint, end = start) {
  const locate = (p: BlockPoint): [Node, number] | null => {
    let block = Array.from(editor.children).find(
      (e) => (e as HTMLElement).dataset.blockId === p.blockId,
    );
    if (p.cell)
      block = Array.from(block?.querySelectorAll<HTMLElement>('[data-cell]') ?? []).find(
        (cell) => cell.dataset.cell === p.cell,
      );
    if (!block) return null;
    if (p.cell) (block as HTMLElement).focus();
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
  return {
    ...rest,
    text: block.text!.slice(start, end),
    ...(marks.length ? { marks } : {}),
  };
}
