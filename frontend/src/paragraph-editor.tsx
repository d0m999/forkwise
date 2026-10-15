import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Block } from '../../backend/src/mapping/contracts';
import { plainParagraph } from '../../backend/src/mapping/body-text';
import {
  unsupportedBlockIds,
  editableTextBlock,
  type InlineMark,
} from '../../backend/src/mapping/general-blocks';
import { BlockMenu, BLOCK_OPTIONS } from './block-menu';
import {
  indentList,
  listDepth,
  listEnd,
  previousListSibling,
  promoteListChildren,
  moveBlockRange,
  indentBlockRange,
} from '../../backend/src/mapping/list-structure';
import { InlineToolbar } from './inline-toolbar';
import { BodyReadingState, foldEnd } from './body-reading-state';
import { CardIcon } from './card-icons';
import { useBlockDrag } from './block-drag';
import { clipboardBlocks, independentBlocks, writeBlocks } from './block-clipboard';
import { markdownShortcut, type TypedRun } from './markdown-input';
import { plainTextBlocks, replaceTextSelection } from './paste-selection';
import { markdownBlocks } from './markdown-paste';
import { htmlBlocks } from './html-paste';
import { LinkPopover } from './link-popover';
import { clipboardImages } from './clipboard-images';
import { TableTools } from './table-tools';
import { CodeTools } from './code-tools';
import { cellBlock, withCell, sameCell } from './table-selection';
import type { TableCell } from '../../backend/src/mapping/general-blocks';
import {
  blockText,
  nodeText,
  readBlock,
  renderBlock,
  restoreSelection,
  sameBlock,
  selectionPoints,
  sliceTextBlock,
  type BlockPoint,
} from './general-block-dom';

export type TextCursor = { start: number; end: number; blockId: string };
type Selection = NonNullable<ReturnType<typeof selectionPoints>>;
type Menu = {
  id: string;
  signature: Block;
  mode: 'convert' | 'insert' | 'slash';
  query: string;
  index: number;
  selection: Selection | null;
  scope?: Block[];
  hiddenIds?: string[];
  section?: boolean;
};
type FormatTarget = {
  selection: Selection;
  originals: Block[];
  left: number;
  top: number;
  link?: boolean;
};
function blank(): Block {
  return {
    id: crypto.randomUUID(),
    type: 'text',
    text: '',
    inlineId: crypto.randomUUID(),
  };
}
function position(editor: HTMLElement): TextCursor {
  const p = selectionPoints(editor);
  return {
    blockId: p?.start.blockId ?? '',
    start: p?.start.offset ?? 0,
    end: p?.end.offset ?? 0,
  };
}
function convert(block: Block, shape: Partial<Block>): Block {
  return {
    id: block.id,
    type: shape.type!,
    text: block.text ?? '',
    ...(block.inlineId ? { inlineId: block.inlineId } : {}),
    ...(block.marks ? { marks: block.marks } : {}),
    ...(shape.type === 'listItem' && block.parentId ? { parentId: block.parentId } : {}),
    ...shape,
  };
}
function matchesTarget(blocks: Block[], target: FormatTarget): boolean {
  const first = blocks.findIndex((b) => b.id === target.selection.start.blockId);
  const current = blocks.slice(first, first + target.originals.length);
  return (
    first >= 0 &&
    current.at(-1)?.id === target.selection.end.blockId &&
    target.originals.every((old, i) => current[i] && sameBlock(old, current[i]!))
  );
}
export function ParagraphEditor({
  readingIdentity,
  blocks,
  readOnly,
  onChange,
  onSelect,
  onComposition,
  onFinish,
  onHistory,
  onOriginalCopy,
}: {
  readingIdentity: string;
  blocks: Block[];
  readOnly: boolean;
  onChange: (blocks: Block[], inputType: string, cursor: TextCursor) => void;
  onSelect: (cursor: TextCursor) => void;
  onComposition: (value: boolean) => void;
  onFinish: () => void;
  onHistory: (direction: 'undo' | 'redo') => Promise<void>;
  onOriginalCopy: (before: Block[], after: Block[]) => void;
}) {
  const element = useRef<HTMLDivElement>(null),
    wrapper = useRef<HTMLDivElement>(null);
  const composing = useRef(false),
    emitted = useRef('');
  const nativeIds = useRef(new WeakMap<Node, { id: string; inlineId: string }>());
  const selectFrame = useRef<number | undefined>(undefined);
  const interaction = useRef(0);
  const typed = useRef<TypedRun | null>(null);
  const pointerStart = useRef({ x: 0, y: 0 });
  const pasteEpoch = useRef(0);
  const selectionAnchor = useRef('');
  const pendingHistorySelection = useRef<{
    action: number;
    selection: Selection | null;
    wasBlocked: boolean;
    ready: boolean;
  } | null>(null);
  const [historySelectionRevision, setHistorySelectionRevision] = useState(0);
  const mounted = useRef(true),
    latestReadOnly = useRef(readOnly);
  latestReadOnly.current = readOnly;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [activeId, setActiveId] = useState(''),
    [menu, setMenu] = useState<Menu | null>(null);
  const [notice, setNotice] = useState('');
  const [activeCell, setActiveCell] = useState('0,0');
  const [readingState] = useState(() => new BodyReadingState(readingIdentity));
  const reading = useRef(readingState);
  const [readingRevision, setReadingRevision] = useState(0);
  const [foldControls, setFoldControls] = useState<
    { id: string; name: string; top: number; collapsed: boolean }[]
  >([]);
  const [blockControls, setBlockControls] = useState<{ id: string; name: string; top: number }[]>(
    [],
  );
  const [formatTarget, setFormatTarget] = useState<FormatTarget | null>(null);
  const [linkTarget, setLinkTarget] = useState<{
    key: string;
    target: FormatTarget;
    url: string;
    text: string;
    preview: boolean;
    readOnly: boolean;
  } | null>(null);
  const supported = unsupportedBlockIds(blocks).size === 0;
  const drag = useBlockDrag({
    editor: element,
    blocks,
    disabled: readOnly || composing.current,
    read,
    selected: () => menu?.scope,
    start: () => {
      setMenu(null);
      setFormatTarget(null);
      onFinish();
    },
    commit: (next, id) => apply(next, { blockId: id, offset: 0 }, 'insertFromDrop'),
  });
  useLayoutEffect(() => {
    for (const node of Array.from(element.current?.children ?? [])) {
      (node as HTMLElement).dataset.blockDragging = String(
        drag.preview?.ids.includes((node as HTMLElement).dataset.blockId!) ?? false,
      );
    }
  }, [drag.preview]);
  useLayoutEffect(() => {
    for (const node of Array.from(element.current?.children ?? [])) {
      const child = node as HTMLElement;
      child.dataset.blockSelected = String(
        !!menu?.scope?.some((b) => b.id === child.dataset.blockId),
      );
    }
  }, [menu, blocks]);
  function read(): Block[] {
    if (!supported) return blocks;
    const editor = element.current!;
    const children = Array.from(editor.children).filter(
      (e): e is HTMLElement => e instanceof HTMLElement && e.tagName !== 'BR',
    );
    if (!children.length) {
      const original = blocks[0]!;
      return [
        {
          id: original.id,
          type: 'text',
          text: blockText(editor),
          inlineId: original.inlineId ?? editor.dataset.inlineId!,
        },
      ];
    }
    const seen = new Set<string>();
    return children.map((p, i) => {
      let identity = nativeIds.current.get(p);
      if (!identity) {
        const candidate = p.dataset.blockId ?? (i === 0 ? blocks[0]!.id : '');
        const id = candidate && !seen.has(candidate) ? candidate : crypto.randomUUID();
        identity = {
          id,
          inlineId:
            id === candidate && p.dataset.inlineId ? p.dataset.inlineId : crypto.randomUUID(),
        };
        nativeIds.current.set(p, identity);
      }
      if (seen.has(identity.id)) {
        identity = { id: crypto.randomUUID(), inlineId: crypto.randomUUID() };
        nativeIds.current.set(p, identity);
      }
      seen.add(identity.id);
      p.dataset.blockId = identity.id;
      p.dataset.inlineId = identity.inlineId;
      return readBlock(p, identity.id, identity.inlineId);
    });
  }
  function render(next: Block[]) {
    const editor = element.current!;
    const ordinals = new Map<string, number>();
    editor.replaceChildren(
      ...next.map((block) => {
        const p = renderBlock(block);
        if (block.type === 'listItem') p.style.marginLeft = `${listDepth(next, block) * 24}px`;
        if (block.listType === 'ordered') {
          const previous = previousListSibling(next, next.indexOf(block));
          const ordinal =
            previous >= 0 && next[previous]!.listType === 'ordered'
              ? (ordinals.get(next[previous]!.id) ?? 0) + 1
              : 1;
          ordinals.set(block.id, ordinal);
          p.dataset.ordinal = String(ordinal);
        }
        nativeIds.current.set(p, {
          id: block.id,
          inlineId: p.dataset.inlineId!,
        });
        return p;
      }),
    );
    editor.dataset.inlineId = (editor.firstElementChild as HTMLElement)?.dataset.inlineId;
  }
  useLayoutEffect(() => {
    if (
      !element.current ||
      !supported ||
      composing.current ||
      emitted.current === JSON.stringify(blocks)
    )
      return;
    if (element.current.childNodes.length) {
      const current = read();
      if (current.length === blocks.length && blocks.every((b, i) => sameBlock(b, current[i]!)))
        return;
    }
    if (menu) {
      const target = blocks.find((b) => b.id === menu.id);
      if (!target || !sameBlock(menu.signature, target)) {
        setMenu(null);
        if (!readOnly) setNotice('原目标已失效，操作已取消');
      }
    }
    if (formatTarget && !matchesTarget(blocks, formatTarget)) {
      setFormatTarget(null);
      if (!readOnly) setNotice('原文字选区已失效，操作已取消');
    }
    render(blocks);
    emitted.current = JSON.stringify(blocks);
  }, [blocks, supported]);
  useLayoutEffect(() => {
    const editor = element.current,
      wrap = wrapper.current;
    if (!editor || !wrap) return;
    const hidden = reading.current.hidden(blocks);
    for (const node of Array.from(editor.children)) {
      const child = node as HTMLElement;
      child.hidden = hidden.has(child.dataset.blockId!);
    }
    const measure = () => {
      const top = wrap.getBoundingClientRect().top;
      const nodes = new Map(
        Array.from(editor.children).map((node) => [
          (node as HTMLElement).dataset.blockId,
          node as HTMLElement,
        ]),
      );
      const controls = blocks.flatMap((block) => {
        const node = nodes.get(block.id);
        return !hidden.has(block.id) && node
          ? [
              {
                id: block.id,
                name: block.text || block.type,
                top: node.getBoundingClientRect().top - top,
              },
            ]
          : [];
      });
      setBlockControls((current) =>
        JSON.stringify(current) === JSON.stringify(controls) ? current : controls,
      );
      setFoldControls(
        blocks.flatMap((block, i) => {
          if (hidden.has(block.id) || foldEnd(blocks, i) <= i + 1) return [];
          const node = nodes.get(block.id);
          return node
            ? [
                {
                  id: block.id,
                  name: block.text || '空条目',
                  top: node.getBoundingClientRect().top - top,
                  collapsed: reading.current.collapsed(block.id),
                },
              ]
            : [];
        }),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(editor);
    return () => observer.disconnect();
  }, [blocks, supported, readingRevision]);
  function toggleFold(id: string) {
    if (composing.current) return;
    const current = read(),
      index = current.findIndex((b) => b.id === id),
      selection = selectionPoints(element.current!);
    const willHide = current
      .slice(index + 1, foldEnd(current, index))
      .some((b) => b.id === selection?.start.blockId || b.id === selection?.end.blockId);
    onFinish();
    if (!reading.current.collapsed(id) && willHide) {
      element.current!.focus();
      restoreSelection(element.current!, { blockId: id, offset: 0 });
      setActiveId(id);
    }
    try {
      reading.current.toggle(id);
    } catch {
      setNotice('折叠偏好保存失败，当前阅读状态仍保留');
    }
    setReadingRevision((r) => r + 1);
  }
  useLayoutEffect(() => {
    for (const cell of element.current?.querySelectorAll<HTMLElement>('[data-cell]') ?? []) {
      cell.contentEditable = String(!readOnly);
      cell.setAttribute('aria-readonly', String(readOnly));
    }
    if (readOnly && element.current?.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur();
      element.current.blur();
      window.getSelection()?.removeAllRanges();
    }
    if (readOnly && menu) {
      setMenu(null);
      setNotice('原目标已失效，操作已取消');
    }
    if (readOnly) pasteEpoch.current++;
  }, [readOnly, blocks]);
  useLayoutEffect(() => {
    const pending = pendingHistorySelection.current;
    if (!pending) return;
    if (readOnly) {
      pending.wasBlocked = true;
      return;
    }
    if (!pending.wasBlocked && !pending.ready) return;
    pendingHistorySelection.current = null;
    const editor = element.current;
    if (!editor?.isConnected || !supported || interaction.current !== pending.action) return;
    editor.focus();
    const current = read(),
      saved = pending.selection,
      point =
        saved && current.some((block) => block.id === saved.start.blockId)
          ? saved.start
          : {
              blockId: current.at(-1)!.id,
              offset: current.at(-1)!.text?.length ?? 0,
            };
    restoreSelection(
      editor,
      point,
      saved && current.some((block) => block.id === saved.end.blockId) ? saved.end : point,
    );
    selected();
  }, [blocks, readOnly, supported, historySelectionRevision]);
  useLayoutEffect(() => {
    if (readOnly || composing.current || !supported) return;
    const table = blocks.find((block) => block.id === activeId && block.type === 'table');
    if (!table || cellBlock(table, activeCell)) return;
    const editor = element.current!;
    const node = Array.from(editor.children).find(
      (child) => (child as HTMLElement).dataset.blockId === table.id,
    );
    const first = node?.querySelector<HTMLElement>('[data-cell]');
    if (!first?.dataset.cell) return;
    // A removed cell has no surviving identity. Rebind the actual selection
    // to an existing cell before enabling operations; do not clamp labels.
    restoreSelection(editor, { blockId: table.id, cell: first.dataset.cell, offset: 0 });
    selected();
    const [row, column] = first.dataset.cell.split(',').map(Number);
    setNotice(`原单元格已不在表格中，已定位到第 ${row! + 1} 行第 ${column! + 1} 列`);
  }, [blocks, readOnly, supported, activeId, activeCell]);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => {
      if (
        !composing.current &&
        e.target instanceof Node &&
        !(e.target instanceof Element && e.target.closest('[data-block-selector]')) &&
        !wrapper.current?.querySelector('.block-menu')?.contains(e.target) &&
        !(e.target instanceof Element && e.target.closest('[aria-label="块原件操作"]'))
      )
        setMenu(null);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [menu]);
  function apply(next: Block[], start: BlockPoint, inputType: string, end = start) {
    if (readOnly || composing.current) return;
    if (unsupportedBlockIds(next).size) {
      // DOM reading may assign unsaved inline identities; compare the canonical input.
      onOriginalCopy(blocks, next);
      setMenu(null);
      return;
    }
    const editor = element.current!;
    onFinish();
    reading.current.reveal(next, [start.blockId, end.blockId]);
    setReadingRevision((r) => r + 1);
    render(next);
    editor.focus();
    restoreSelection(editor, start, end);
    const actual = read();
    emitted.current = JSON.stringify(actual);
    setActiveId(start.blockId);
    onChange(actual, inputType, position(editor));
    onFinish();
  }
  function selected() {
    if (!element.current || composing.current) return;
    const p = position(element.current);
    if (p.blockId) setActiveId(p.blockId);
    const cell = selectionPoints(element.current)?.start.cell;
    if (cell) setActiveCell(cell);
    onSelect(p);
    if (document.activeElement?.closest('.inline-toolbar, .block-menu, .link-popover')) return;
    const selection = selectionPoints(element.current);
    if (
      selection &&
      (selection.start.blockId !== selection.end.blockId ||
        selection.start.offset !== selection.end.offset)
    ) {
      const current = read(),
        first = current.findIndex((b) => b.id === selection.start.blockId),
        last = current.findIndex((b) => b.id === selection.end.blockId);
      const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      setFormatTarget({
        selection,
        originals: current.slice(first, last + 1),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 330)),
        top: Math.max(8, Math.min(rect.top - 44, window.innerHeight - 260)),
      });
    } else setFormatTarget(null);
  }
  function tableChange(table: Block, cell: string) {
    const next = read(),
      index = next.findIndex((b) => b.id === table.id);
    if (index < 0 || !sameBlock(blocks.find((b) => b.id === table.id)!, next[index]!)) {
      setNotice('原表格已变化，请重新选择单元格');
      return;
    }
    if (sameBlock(next[index]!, table)) return;
    next[index] = table;
    setActiveCell(cell);
    apply(next, { blockId: table.id, offset: 0, cell }, 'formatTable');
  }
  function paragraphAfter(id: string) {
    const next = read(),
      index = next.findIndex((b) => b.id === id);
    if (index < 0) return;
    const following = blank();
    next.splice(index + 1, 0, following);
    apply(next, { blockId: following.id, offset: 0 }, 'insertParagraph');
  }
  function codeChange(code: Block) {
    const next = read(),
      index = next.findIndex((b) => b.id === code.id);
    if (index < 0 || !sameBlock(blocks.find((b) => b.id === code.id)!, next[index]!)) {
      setNotice('原代码块已变化，请重新选择');
      return;
    }
    if (sameBlock(next[index]!, code)) return;
    next[index] = code;
    apply(next, { blockId: code.id, offset: 0 }, 'formatCode');
  }
  async function copyCode(id: string) {
    if (readOnly || composing.current) return;
    const code = read().find((block) => block.id === id);
    if (code?.type !== 'code') return;
    onFinish();
    try {
      await navigator.clipboard.writeText(code.text!);
      if (mounted.current) setNotice('已复制代码');
    } catch {
      if (mounted.current) setNotice('代码复制失败，原文已保留');
    }
  }
  function format(
    type: InlineMark['type'],
    value?: string,
    target = formatTarget,
    removeOnly = false,
  ) {
    if (!target || readOnly || composing.current) return;
    const next = read(),
      { selection } = target;
    if (!matchesTarget(next, target)) {
      setFormatTarget(null);
      setNotice('原文字选区已失效，操作已取消');
      return;
    }
    const first = next.findIndex((b) => b.id === selection.start.blockId),
      last = next.findIndex((b) => b.id === selection.end.blockId);
    const cell =
      next[first] && sameCell(selection.start, selection.end)
        ? cellBlock(next[first]!, selection.start.cell)
        : null;
    const textBlocks = cell ? [cell] : next.slice(first, last + 1);
    if (first < 0 || last < first || !textBlocks.every(editableTextBlock)) {
      setFormatTarget(null);
      setNotice('原文字选区已失效，操作已取消');
      return;
    }
    const ranges = textBlocks.map((b, i) => ({
      block: b,
      start: i ? 0 : selection.start.offset,
      end: i === last - first ? selection.end.offset : b.text!.length,
    }));
    const remove =
      removeOnly ||
      (type !== 'link' &&
        ranges.every(({ block, start, end }) => {
          let covered = start;
          for (const m of ((block.marks ?? []) as InlineMark[])
            .filter((m) => m.type === type && (value === undefined || m.value === value))
            .sort((a, b) => a.start - b.start))
            if (m.start <= covered) covered = Math.max(covered, m.end);
          return covered >= end;
        }));
    for (const { block, start, end } of ranges) {
      const marks = ((block.marks ?? []) as InlineMark[]).flatMap((m) => {
        if (m.type !== type || m.end <= start || m.start >= end) return [m];
        return [
          ...(m.start < start ? [{ ...m, end: start }] : []),
          ...(m.end > end ? [{ ...m, start: end }] : []),
        ];
      });
      if (!remove && end > start) marks.push({ type, start, end, ...(value ? { value } : {}) });
      const { marks: oldMarks, ...rest } = block;
      const formatted = {
        ...rest,
        ...(marks.length ? { marks } : {}),
      };
      const index = next.findIndex((b) => b.id === block.id);
      next[index] = cell ? withCell(next[index]!, selection.start.cell!, formatted) : formatted;
    }
    apply(next, selection.start, 'formatInline', selection.end);
    const actual = read();
    setFormatTarget({
      ...target,
      originals: actual.slice(first, last + 1),
    });
  }
  function openLink(preview = false, anchor?: HTMLAnchorElement) {
    if (readOnly || composing.current) return;
    const current = read();
    let selection = selectionPoints(element.current!);
    let block = current.find((b) => b.id === selection?.start.blockId);
    if (anchor) {
      const parent = anchor.closest<HTMLElement>('[data-cell], [data-block-id]');
      if (!parent) return;
      block = current.find(
        (b) => b.id === parent.closest<HTMLElement>('[data-block-id]')?.dataset.blockId,
      );
      if (!block) return;
      const prefix = document.createRange();
      prefix.selectNodeContents(parent);
      prefix.setEndBefore(anchor);
      const offset = nodeText(prefix.cloneContents()).length;
      const point = {
        blockId: block.id,
        offset,
        ...(parent.dataset.cell ? { cell: parent.dataset.cell } : {}),
      };
      selection = { start: point, end: point };
    }
    if (!selection || !block || block.type === 'code') return;
    if (selection.start.cell && !sameCell(selection.start, selection.end)) return;
    const cell = cellBlock(block, selection.start.cell);
    const textBlock = cell ?? block;
    const collapsed =
      selection.start.blockId === selection.end.blockId &&
      selection.start.offset === selection.end.offset;
    const mark = ((textBlock.marks ?? []) as InlineMark[]).find(
      (m) =>
        m.type === 'link' && m.start <= selection!.start.offset && m.end > selection!.start.offset,
    );
    if (collapsed && mark)
      selection = {
        start: { ...selection.start, offset: mark.start },
        end: { ...selection.end, offset: mark.end },
      };
    const first = current.findIndex((b) => b.id === selection!.start.blockId),
      last = current.findIndex((b) => b.id === selection!.end.blockId);
    if (first < 0 || last < first) return;
    const originals = current.slice(first, last + 1);
    const text = (cell ? [cell] : originals)
      .map((b, i) =>
        (b.text ?? '').slice(
          i === 0 ? selection!.start.offset : 0,
          i === originals.length - 1 ? selection!.end.offset : undefined,
        ),
      )
      .join('\n');
    const rect =
      anchor?.getBoundingClientRect() ??
      window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    onFinish();
    setMenu(null);
    setLinkTarget({
      key: crypto.randomUUID(),
      target: {
        selection,
        originals: structuredClone(originals),
        left: Math.max(8, Math.min(rect?.left ?? 8, innerWidth - 360)),
        top: Math.max(8, Math.min(rect?.bottom ?? 100, innerHeight - 260)),
      },
      url: anchor?.getAttribute('href') ?? mark?.value ?? '',
      text,
      preview,
      readOnly: !(cell ? [cell] : originals).every(editableTextBlock),
    });
  }
  function closeLink() {
    if (!linkTarget) return;
    const target = linkTarget.target;
    setLinkTarget(null);
    setFormatTarget(null);
    if (element.current && matchesTarget(read(), target)) {
      element.current.focus();
      restoreSelection(element.current, target.selection.start, target.selection.end);
    }
  }
  function applyLink(url?: string, text?: string) {
    if (!linkTarget || linkTarget.readOnly || readOnly || composing.current) return;
    const { target } = linkTarget,
      current = read();
    if (!matchesTarget(current, target)) {
      setLinkTarget(null);
      setNotice('原文字选区已失效，操作已取消');
      return;
    }
    if (url && text !== linkTarget.text) {
      const inserted = [
        {
          ...blank(),
          text: text!,
          marks: [{ type: 'link', start: 0, end: text!.length, value: url }],
        },
      ];
      const result = replaceTextSelection(current, target.selection, inserted);
      if (!result) {
        setNotice('原文字选区已失效，操作已取消');
        setLinkTarget(null);
        return;
      }
      apply(result.blocks, result.point, 'formatLink');
    } else format('link', url, target, !url);
    setLinkTarget(null);
    setFormatTarget(null);
  }
  function openMenu(mode: Menu['mode'], id = activeId, extend = false) {
    if (readOnly || composing.current) return;
    const current = read(),
      index = current.findIndex((b) => b.id === id),
      block = current[index];
    if (!block) return;
    onFinish();
    setNotice('');
    setFormatTarget(null);
    const hiddenIds = [...reading.current.hidden(current)];
    const extending = extend && !!menu?.scope;
    const anchorIndex = extending
      ? current.findIndex((b) => b.id === selectionAnchor.current)
      : index;
    const first = anchorIndex < 0 ? index : Math.min(anchorIndex, index);
    let last = anchorIndex < 0 ? index + 1 : Math.max(anchorIndex, index) + 1;
    for (let i = first; i < last; i++) last = Math.max(last, listEnd(current, i));
    const scope = current.slice(first, last);
    if (!extending || anchorIndex < 0) selectionAnchor.current = id;
    if (mode === 'convert') {
      reading.current.reveal(
        current,
        current.slice(first, Math.max(last, foldEnd(current, index))).map((b) => b.id),
      );
      setReadingRevision((r) => r + 1);
    }
    setMenu({
      id,
      signature: block,
      mode,
      query: '',
      index: 0,
      selection: element.current ? selectionPoints(element.current) : null,
      ...(mode === 'convert' ? { scope, hiddenIds } : {}),
    });
  }
  function selectSection() {
    if (!menu || menu.signature.type !== 'heading') return;
    const current = read(),
      index = current.findIndex((b) => b.id === menu.id);
    if (index < 0 || !sameBlock(current[index]!, menu.signature)) return;
    const scope = current.slice(index, foldEnd(current, index));
    reading.current.reveal(
      current,
      scope.map((b) => b.id),
    );
    setReadingRevision((r) => r + 1);
    setMenu({ ...menu, scope, section: true });
  }
  function organize(
    action: 'up' | 'down' | 'delete' | 'indent' | 'outdent' | 'duplicate',
    scope = menu?.scope,
  ) {
    if (!scope || readOnly || composing.current) return;
    const current = read(),
      first = current.findIndex((b) => b.id === scope[0]!.id);
    if (
      first < 0 ||
      !scope.every((b, i) => current[first + i] && sameBlock(b, current[first + i]!))
    ) {
      setMenu(null);
      setNotice('原目标已失效，操作已取消');
      return;
    }
    const ids = scope.map((b) => b.id);
    let next = current;
    if (action === 'duplicate') {
      const roots = scope.filter((b) => !ids.includes(b.parentId as string));
      const parent = roots.every((b) => b.parentId === roots[0]!.parentId)
        ? roots[0]!.parentId
        : undefined;
      const copies = independentBlocks(scope, parent as string | undefined, [
        ...unsupportedBlockIds(current),
      ]);
      next = [...current];
      next.splice(first + ids.length, 0, ...copies);
    } else if (action === 'delete') next = current.filter((b) => !ids.includes(b.id));
    else if (action === 'indent' || action === 'outdent')
      next = indentBlockRange(current, ids, action === 'outdent');
    else next = moveBlockRange(current, ids, action === 'up' ? -1 : 1);
    if (next === current) return;
    if (!next.length) next = [blank()];
    const target =
      next.find((b) => b.id === scope[0]!.id) ?? next[Math.min(first, next.length - 1)]!;
    setMenu(null);
    apply(next, { blockId: target.id, offset: 0 }, 'organizeBlocks');
  }
  async function copy(cut: boolean) {
    if (!menu?.scope || readOnly || composing.current) return;
    const source = read(),
      first = source.findIndex((b) => b.id === menu.scope![0]!.id);
    if (
      first < 0 ||
      !menu.scope.every((block, i) => source[first + i] && sameBlock(block, source[first + i]!))
    ) {
      setMenu(null);
      setNotice('原目标已失效，操作已取消');
      return;
    }
    const frozen = structuredClone(menu.scope);
    try {
      await writeBlocks(frozen, [...unsupportedBlockIds(source)]);
      if (!mounted.current) return;
      if (cut) {
        if (
          latestReadOnly.current ||
          composing.current ||
          JSON.stringify(read()) !== JSON.stringify(source)
        ) {
          setNotice('原目标已变化，已复制但未剪切');
          return;
        }
        organize('delete');
      } else setMenu(null);
      setNotice(cut ? '已剪切所选块' : '已复制所选块');
    } catch {
      if (mounted.current) setNotice('剪贴板写入失败，原文已保留');
    }
  }
  function pasteBlocks(source: Block[], readonlyIds: string[]) {
    if (readOnly || composing.current) return;
    const current = read(),
      selected = selectionPoints(element.current!);
    let index = current.findIndex((b) => b.id === (selected?.end.blockId ?? activeId));
    if (index < 0) {
      setNotice('请选择正文中的粘贴位置');
      return;
    }
    if (
      selected &&
      (selected.start.cell !== undefined ||
        selected.start.blockId !== selected.end.blockId ||
        selected.start.offset !== selected.end.offset ||
        selected.end.offset < (current[index]!.text?.length ?? 0))
    ) {
      const replacement = replaceTextSelection(
        current,
        selected,
        independentBlocks(source, undefined, readonlyIds),
      );
      if (!replacement) {
        setNotice('此选区不能可靠粘贴，原文已保留');
        return;
      }
      setMenu(null);
      setFormatTarget(null);
      apply(replacement.blocks, replacement.point, 'insertFromPaste');
      return;
    }
    // Non-list roots stay at the document level, after the enclosing list.
    if (source.some((block) => block.type !== 'listItem' || readonlyIds.includes(block.id)))
      while (current[index]!.parentId)
        index = current.findIndex((block) => block.id === current[index]!.parentId);
    const copies = independentBlocks(
      source,
      current[index]!.parentId as string | undefined,
      readonlyIds,
    );
    const next = [...current];
    next.splice(listEnd(current, index), 0, ...copies);
    setMenu(null);
    setFormatTarget(null);
    apply(next, { blockId: copies[0]!.id, offset: 0 }, 'insertFromPaste');
  }
  function pasteText(text: string, selection = selectionPoints(element.current!)) {
    if (!selection || !text) return;
    const replacement = replaceTextSelection(read(), selection, plainTextBlocks(text));
    if (!replacement) {
      setNotice('此选区不能可靠粘贴，原文已保留');
      return;
    }
    typed.current = null;
    setMenu(null);
    setFormatTarget(null);
    apply(replacement.blocks, replacement.point, 'insertFromPaste');
  }
  function pasteTarget(frozen: Block[], epoch: number): Block[] | null {
    if (!mounted.current) return null;
    const current = read();
    if (
      latestReadOnly.current ||
      composing.current ||
      pasteEpoch.current !== epoch ||
      current.length !== frozen.length ||
      !frozen.every((b, i) => sameBlock(b, current[i]!))
    ) {
      setNotice('原目标已失效，操作已取消');
      return null;
    }
    return current;
  }
  async function pasteImages(files: File[], selection: Selection, html: string, text: string) {
    const frozen = structuredClone(read()),
      epoch = ++pasteEpoch.current;
    onFinish();
    try {
      const content = html ? htmlBlocks(html, text) : { blocks: text ? plainTextBlocks(text) : [] };
      const images = await clipboardImages(files);
      const current = pasteTarget(frozen, epoch);
      if (!current) return;
      const unique = images.filter(
        (image) =>
          !content.blocks.some(
            (block) =>
              block.type === 'pendingImage' &&
              block.base64 === image.base64 &&
              block.mime === image.mime &&
              block.name === image.name,
          ),
      );
      const replacement = replaceTextSelection(current, selection, [
        ...content.blocks,
        ...unique,
        blank(),
      ]);
      if (!replacement) {
        setNotice('此选区不能可靠粘贴，原文已保留');
        return;
      }
      if (new TextEncoder().encode(JSON.stringify(replacement.blocks)).length > 850000) {
        setNotice('图片与正文超过本次暂存上限，原剪贴板与正文均保留');
        return;
      }
      setMenu(null);
      setFormatTarget(null);
      apply(replacement.blocks, replacement.point, 'insertFromPaste');
      if ('notice' in content && content.notice) setNotice(content.notice);
    } catch (error) {
      if (mounted.current)
        setNotice(error instanceof Error ? error.message : '图片读取失败，原剪贴板与正文均保留');
    }
  }
  async function explicitPaste(markdown: boolean) {
    if (!menu || readOnly || composing.current) return;
    const current = read(),
      block = current.find((b) => b.id === menu.id);
    if (!block || !sameBlock(menu.signature, block)) {
      setMenu(null);
      setNotice('原目标已失效，操作已取消');
      return;
    }
    const selection = menu.selection ?? {
      start: { blockId: block.id, offset: block.text?.length ?? 0 },
      end: { blockId: block.id, offset: block.text?.length ?? 0 },
    };
    const frozen = structuredClone(current),
      epoch = ++pasteEpoch.current;
    setMenu(null);
    setFormatTarget(null);
    typed.current = null;
    try {
      const text = await navigator.clipboard.readText();
      const latest = pasteTarget(frozen, epoch);
      if (!latest) return;
      if (!text) return;
      const inCode = latest.find((b) => b.id === selection.start.blockId)?.type === 'code';
      const replacement = replaceTextSelection(
        latest,
        selection,
        markdown && !inCode ? markdownBlocks(text) : plainTextBlocks(text),
      );
      if (!replacement) {
        setNotice('此选区不能可靠粘贴，原文已保留');
        return;
      }
      apply(replacement.blocks, replacement.point, 'insertFromPaste');
    } catch {
      if (mounted.current) setNotice('剪贴板读取失败，原文已保留');
    }
  }
  const options = BLOCK_OPTIONS.filter(
    (o) =>
      (menu?.mode !== 'convert' || !['divider', 'table'].includes(o.shape.type!)) &&
      o.name.includes(menu?.query ?? ''),
  ).map((option) => ({
    ...option,
    disabled:
      !!menu &&
      ((menu.mode === 'convert' &&
        !editableTextBlock(menu.signature) &&
        menu.signature.type !== 'code') ||
        (menu.mode === 'convert' &&
          menu.signature.type === 'code' &&
          option.shape.type !== 'text') ||
        (menu.scope?.filter((b) => !menu.scope!.some((parent) => parent.id === b.parentId))
          .length ?? 0) > 1 ||
        (!!menu.signature.parentId && option.shape.type !== 'listItem')),
  }));
  function choose(index: number) {
    if (!menu || composing.current || readOnly) return;
    const option = options[index];
    if (!option || option.disabled) return;
    let next = read();
    const i = next.findIndex((b) => b.id === menu.id),
      block = next[i];
    setMenu(null);
    if (!block || !sameBlock(menu.signature, block)) {
      setNotice('原目标已失效，操作已取消');
      return;
    }
    const reuse = menu.mode !== 'insert' || (block.type === 'text' && !block.text);
    let target = convert(
      reuse
        ? block
        : {
            ...blank(),
            ...(block.parentId ? { parentId: block.parentId } : {}),
          },
      option.shape,
    );
    if (menu.mode === 'slash')
      target = convert({ ...block, text: '', marks: undefined }, option.shape);
    if (target.type === 'divider')
      target = {
        id: target.id,
        type: 'divider',
        ...(target.inlineId ? { inlineId: target.inlineId } : {}),
      };
    if (target.type === 'table')
      target = {
        id: target.id,
        type: 'table',
        inlineId: target.inlineId,
        header: false,
        rows: structuredClone(option.shape.rows),
      };
    if (target.type === 'code')
      target = {
        id: target.id,
        type: 'code',
        inlineId: target.inlineId,
        text: target.text ?? '',
        language: '',
        wrap: false,
      };
    if (menu.mode === 'convert' && sameBlock(block, target)) {
      element.current!.focus();
      if (menu.selection)
        restoreSelection(element.current!, menu.selection.start, menu.selection.end);
      return;
    }
    if (reuse && block.type === 'listItem' && target.type !== 'listItem')
      next = promoteListChildren(next, i);
    const targetIndex = reuse ? i : listEnd(next, i);
    next.splice(targetIndex, reuse ? 1 : 0, target);
    let point: BlockPoint = {
      blockId: target.id,
      offset:
        menu.mode === 'convert' ? (menu.selection?.start.offset ?? target.text?.length ?? 0) : 0,
    };
    if (target.type === 'divider') {
      const following = blank();
      next.splice(targetIndex + 1, 0, following);
      point = { blockId: following.id, offset: 0 };
    }
    if (target.type === 'table') point = { ...point, cell: '0,0' };
    apply(
      next,
      point,
      'formatBlock',
      menu.mode === 'convert' && menu.selection ? menu.selection.end : point,
    );
  }
  function menuKey(event: React.KeyboardEvent) {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current || !menu)
      return;
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (event.key === 'Escape') {
      setMenu(null);
      element.current!.focus();
      if (menu.selection)
        restoreSelection(element.current!, menu.selection.start, menu.selection.end);
    } else if (event.key === 'Enter') choose(menu.index);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp')
      setMenu({
        ...menu,
        index: options.length
          ? (menu.index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length
          : 0,
      });
  }
  function enter(soft: boolean) {
    const selection = selectionPoints(element.current!);
    if (!selection) return false;
    let next = read();
    const i = next.findIndex((b) => b.id === selection.start.blockId),
      block = next[i];
    if (
      block?.type === 'table' &&
      selection.start.cell &&
      selection.start.cell === selection.end.cell
    ) {
      const [r, c] = selection.start.cell.split(',').map(Number);
      const rows = structuredClone(block.rows as TableCell[][]),
        cell = rows[r!]![c!]!;
      const before = sliceTextBlock(
        { id: 'cell', type: 'text', ...cell },
        0,
        selection.start.offset,
      );
      const after = sliceTextBlock(
        { id: 'cell', type: 'text', ...cell },
        selection.end.offset,
        cell.text.length,
      );
      const marks = [
        ...((before.marks ?? []) as InlineMark[]),
        ...((after.marks ?? []) as InlineMark[]).map((m) => ({
          ...m,
          start: m.start + selection.start.offset + 1,
          end: m.end + selection.start.offset + 1,
        })),
      ];
      rows[r!]![c!] = {
        text: before.text! + '\n' + after.text!,
        ...(marks.length ? { marks } : {}),
      };
      next[i] = { ...block, rows };
      apply(next, { ...selection.start, offset: selection.start.offset + 1 }, 'insertLineBreak');
      return true;
    }
    if (block?.type === 'code' && selection.start.blockId === selection.end.blockId) {
      const text = block.text!;
      const indentation =
        text
          .slice(text.lastIndexOf('\n', selection.start.offset - 1) + 1, selection.start.offset)
          .match(/^[\t ]*/)?.[0] ?? '';
      next[i] = {
        ...block,
        text:
          text.slice(0, selection.start.offset) +
          '\n' +
          indentation +
          text.slice(selection.end.offset),
      };
      apply(
        next,
        {
          blockId: block.id,
          offset: selection.start.offset + 1 + indentation.length,
        },
        'insertLineBreak',
      );
      return true;
    }
    if (!block || selection.start.blockId !== selection.end.blockId || !editableTextBlock(block))
      return false;
    const before = sliceTextBlock(block, 0, selection.start.offset),
      after = sliceTextBlock(block, selection.end.offset, block.text.length);
    if (soft) {
      const marks = [
        ...((before.marks ?? []) as InlineMark[]),
        ...((after.marks ?? []) as InlineMark[]).map((m) => ({
          ...m,
          start: m.start + selection.start.offset + 1,
          end: m.end + selection.start.offset + 1,
        })),
      ];
      const { marks: oldMarks, ...rest } = block;
      next[i] = {
        ...rest,
        text: before.text + '\n' + after.text,
        ...(marks.length ? { marks } : {}),
      };
      apply(next, { blockId: block.id, offset: selection.start.offset + 1 }, 'insertLineBreak');
      return true;
    }
    if (block.type === 'listItem' && !block.text && listEnd(next, i) === i + 1) {
      if (block.parentId) {
        apply(indentList(next, block.id, true), { blockId: block.id, offset: 0 }, 'indentList');
      } else {
        next[i] = convert(block, { type: 'text' });
        apply(next, { blockId: block.id, offset: 0 }, 'formatBlock');
      }
      return true;
    }
    const following: Block = {
      ...after,
      id: crypto.randomUUID(),
      inlineId: crypto.randomUUID(),
      ...(block.type === 'listItem'
        ? block.listType === 'todo'
          ? { checked: false }
          : {}
        : { type: 'text' }),
    };
    if (following.type === 'text') {
      delete following.level;
      delete following.listType;
      delete following.checked;
    }
    const insertion = listEnd(next, i);
    next[i] = before;
    next.splice(insertion, 0, following);
    apply(next, { blockId: following.id, offset: 0 }, 'insertParagraph');
    return true;
  }
  function backspace() {
    const selection = selectionPoints(element.current!);
    if (
      !selection ||
      selection.start.offset ||
      selection.end.offset ||
      selection.start.blockId !== selection.end.blockId
    )
      return false;
    let next = read();
    const i = next.findIndex((b) => b.id === selection.start.blockId),
      block = next[i];
    if (!block || !editableTextBlock(block)) return false;
    if (block.type !== 'text') {
      if (block.type === 'listItem' && block.parentId) {
        apply(indentList(next, block.id, true), selection.start, 'indentList');
        return true;
      }
      if (block.type === 'listItem') next = promoteListChildren(next, i);
      next[i] = convert(block, { type: 'text' });
      apply(next, selection.start, 'formatBlock');
      return true;
    }
    const previous = next[i - 1];
    if (!previous || !editableTextBlock(previous)) return true;
    if (reading.current.hidden(next).has(previous.id)) return true;
    const offset = previous.text.length;
    const marks = [
      ...((previous.marks ?? []) as InlineMark[]),
      ...((block.marks ?? []) as InlineMark[]).map((m) => ({
        ...m,
        start: m.start + offset,
        end: m.end + offset,
      })),
    ];
    next.splice(i - 1, 2, {
      ...previous,
      text: previous.text + block.text,
      ...(marks.length ? { marks } : {}),
    });
    apply(next, { blockId: previous.id, offset }, 'deleteContentBackward');
    return true;
  }
  const selectedHiddenCount =
    menu?.hiddenIds?.filter((id) => menu.scope?.some((block) => block.id === id)).length ?? 0;
  if (!supported)
    return (
      <section className="original-body" aria-label="只读正文原件">
        <p>此正文包含尚不支持的内容，原件只读保留。</p>
        {blocks.map((block, index) => (
          <section
            key={block.id}
            data-block-id={block.id}
            hidden={reading.current.hidden(blocks).has(block.id)}
          >
            {!readOnly && (
              <button
                type="button"
                data-block-selector
                aria-label={`选择块：${block.text || block.type}`}
                onClick={(event) => openMenu('convert', block.id, event.shiftKey)}
              >
                选择块
              </button>
            )}
            {foldEnd(blocks, index) > index + 1 && (
              <button
                type="button"
                aria-label={`${reading.current.collapsed(block.id) ? '展开' : '收起'}：${block.text || '空条目'}`}
                aria-expanded={!reading.current.collapsed(block.id)}
                onClick={() => {
                  try {
                    reading.current.toggle(block.id);
                  } catch {
                    setNotice('折叠偏好保存失败');
                  }
                  setReadingRevision((r) => r + 1);
                }}
              >
                {reading.current.collapsed(block.id) ? '▸' : '▾'}
              </button>
            )}
            <h3>原件：{block.type}</h3>
            <pre>{plainParagraph(block) ? block.text : JSON.stringify(block, null, 2)}</pre>
          </section>
        ))}
        {menu?.scope && !readOnly && (
          <div role="menu" aria-label="块原件操作">
            <p>已选择 {menu.scope.length} 个块</p>
            {!!selectedHiddenCount && <p>包含 {selectedHiddenCount} 个隐藏块，已临时展开</p>}
            <p>未知内容只读保留，副本保留原始格式与资源引用。</p>
            <button role="menuitem" onClick={() => void copy(false)}>
              复制所选块
            </button>
            <button role="menuitem" onClick={() => organize('duplicate')}>
              创建副本
            </button>
            <button role="menuitem" onClick={() => setMenu(null)}>
              取消
            </button>
          </div>
        )}
        {notice && <p role="alert">{notice}</p>}
      </section>
    );
  const active = blocks.find((b) => b.id === activeId);
  const anchor = Array.from(element.current?.children ?? [])
    .find((p) => (p as HTMLElement).dataset.blockId === activeId)
    ?.getBoundingClientRect();
  return (
    <div
      className="general-editor"
      ref={wrapper}
      onPointerLeave={() => {
        if (!menu && !wrapper.current?.contains(document.activeElement)) setActiveId('');
      }}
    >
      {blocks.length === 1 && blocks[0]!.type === 'text' && !blocks[0]!.text && (
        <span className="body-placeholder" aria-hidden="true">
          输入文字，或用 / 插入
        </span>
      )}
      {linkTarget && !readOnly && (
        <LinkPopover
          key={linkTarget.key}
          url={linkTarget.url}
          text={linkTarget.text}
          preview={linkTarget.preview}
          readOnly={linkTarget.readOnly}
          left={linkTarget.target.left}
          top={linkTarget.target.top}
          onApply={applyLink}
          onRemove={() => applyLink()}
          onCancel={closeLink}
        />
      )}
      {formatTarget && !readOnly && !menu && !linkTarget && (
        <InlineToolbar
          onFormat={format}
          onLink={() => openLink()}
          left={formatTarget.left}
          top={formatTarget.top}
          linkInitially={formatTarget.link ?? false}
          onCancel={() => {
            element.current!.focus();
            restoreSelection(
              element.current!,
              formatTarget.selection.start,
              formatTarget.selection.end,
            );
            setFormatTarget(null);
          }}
        />
      )}
      {!readOnly && activeId && (
        <div
          className="block-tools"
          style={{
            top: (anchor?.top ?? 0) - (wrapper.current?.getBoundingClientRect().top ?? 0),
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button type="button" aria-label="插入块" onClick={() => openMenu('insert')}>
            ＋
          </button>
          {active && (editableTextBlock(active) || active.type === 'code') && (
            <button type="button" aria-label="块菜单" onClick={() => openMenu('convert')}>
              <CardIcon name="更多" />
            </button>
          )}
          {active?.listType === 'todo' && (
            <button
              type="button"
              aria-label={active.checked ? '标为未完成' : '标为完成'}
              onClick={() => {
                const next = read();
                apply(
                  next.map((b) => (b.id === activeId ? { ...b, checked: !b.checked } : b)),
                  { blockId: activeId, offset: 0 },
                  'formatTodo',
                );
              }}
            >
              {active.checked ? '已完成' : '未完成'}
            </button>
          )}
        </div>
      )}
      {menu && !readOnly && (
        <BlockMenu
          explanation={
            menu.signature.type === 'listItem'
              ? menu.signature.parentId
                ? '先减少缩进到顶层'
                : listEnd(
                      blocks,
                      blocks.findIndex((b) => b.id === menu.id),
                    ) >
                    blocks.findIndex((b) => b.id === menu.id) + 1
                  ? '子列表将保留在下方'
                  : undefined
              : menu.signature.type === 'code'
                ? '转为段落保留全部字符与换行'
                : menu.mode === 'convert' && editableTextBlock(menu.signature)
                  ? '转为代码去除行内样式，保留文字与换行'
                  : undefined
          }
          options={options}
          selected={menu.index}
          convert={menu.mode === 'convert'}
          query={menu.query}
          slash={menu.mode === 'slash'}
          onQuery={(query) => setMenu({ ...menu, query, index: 0 })}
          onChoose={choose}
          onKeyDown={menuKey}
          left={Math.max(8, Math.min(anchor?.left ?? 8, window.innerWidth - 250))}
          top={Math.max(8, Math.min(anchor?.bottom ?? 100, window.innerHeight - 360))}
        >
          {menu.scope && (
            <div
              role="group"
              aria-label="整理块"
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.stopPropagation();
              }}
            >
              <p>已选择 {menu.scope.length} 个块</p>
              <button role="menuitem" onClick={() => void explicitPaste(true)}>
                粘贴为 Markdown
              </button>
              <button role="menuitem" onClick={() => void explicitPaste(false)}>
                粘贴为纯文本
              </button>
              {!!selectedHiddenCount && <p>包含 {selectedHiddenCount} 个隐藏块，已临时展开</p>}
              {menu.signature.type === 'heading' && (
                <button role="menuitem" onClick={selectSection}>
                  选择本节
                </button>
              )}
              <button role="menuitem" onClick={() => organize('duplicate')}>
                创建副本
              </button>
              <button role="menuitem" onClick={() => void copy(false)}>
                复制所选块
              </button>
              <button role="menuitem" onClick={() => void copy(true)}>
                剪切所选块
              </button>
              <button
                role="menuitem"
                onClick={() => organize('up')}
                disabled={
                  moveBlockRange(
                    blocks,
                    menu.scope.map((b) => b.id),
                    -1,
                  ) === blocks
                }
              >
                上移
              </button>
              <button
                role="menuitem"
                onClick={() => organize('down')}
                disabled={
                  moveBlockRange(
                    blocks,
                    menu.scope.map((b) => b.id),
                    1,
                  ) === blocks
                }
              >
                下移
              </button>
              {menu.signature.type === 'listItem' && (
                <>
                  <button
                    role="menuitem"
                    onClick={() => organize('indent')}
                    disabled={
                      indentBlockRange(
                        blocks,
                        menu.scope.map((b) => b.id),
                        false,
                      ) === blocks
                    }
                  >
                    增加缩进
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => organize('outdent')}
                    disabled={
                      indentBlockRange(
                        blocks,
                        menu.scope.map((b) => b.id),
                        true,
                      ) === blocks
                    }
                  >
                    减少缩进
                  </button>
                </>
              )}
              <button role="menuitem" onClick={() => organize('delete')}>
                {menu.section
                  ? `删除所选 ${menu.scope.length} 个块`
                  : menu.signature.type === 'heading'
                    ? '仅删除标题（保留正文）'
                    : menu.signature.type === 'listItem' && menu.scope.length > 1
                      ? `删除此项及 ${menu.scope.length - 1} 个子项`
                      : '删除此块'}
              </button>
            </div>
          )}
        </BlockMenu>
      )}
      {notice && <p role="alert">{notice}</p>}
      {!readOnly && active?.type === 'table' && (
        <TableTools
          table={active}
          cell={activeCell}
          onChange={tableChange}
          onParagraph={() => paragraphAfter(active.id)}
        />
      )}
      {!readOnly && active?.type === 'code' && (
        <CodeTools
          code={active}
          onChange={codeChange}
          onParagraph={() => paragraphAfter(active.id)}
          onCopy={() => void copyCode(active.id)}
        />
      )}
      {!readOnly && (
        <div className="block-handles">
          {blockControls.map((control) => (
            <button
              key={control.id}
              type="button"
              className="block-handle"
              data-block-selector
              style={{ top: control.top }}
              aria-label={`选择块：${control.name}`}
              title="选择内容块；Shift 连续选择；拖动调整顺序"
              onMouseDown={(event) => event.preventDefault()}
              onPointerDown={(event) => drag.begin(event, control.id)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current)
                  return;
                const action = event.altKey
                  ? (
                      {
                        ArrowUp: 'up',
                        ArrowDown: 'down',
                        ArrowRight: 'indent',
                        ArrowLeft: 'outdent',
                      } as const
                    )[event.key as 'ArrowUp']
                  : event.key === 'Delete' || event.key === 'Backspace'
                    ? 'delete'
                    : undefined;
                if (action) {
                  event.preventDefault();
                  event.stopPropagation();
                  const current = read(),
                    index = current.findIndex((b) => b.id === control.id);
                  organize(
                    action,
                    menu?.scope?.some((b) => b.id === control.id)
                      ? menu.scope
                      : current.slice(index, listEnd(current, index)),
                  );
                }
              }}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Delete"
              onClick={(event) => {
                if (!drag.consumeClick()) openMenu('convert', control.id, event.shiftKey);
              }}
            >
              <CardIcon name="更多" />
            </button>
          ))}
        </div>
      )}
      {drag.preview?.drop && (
        <div
          className="block-drop-line"
          aria-label="块落点"
          role="status"
          style={{
            top: drag.preview.drop.top,
            left: drag.preview.drop.left,
            width: drag.preview.drop.width,
          }}
        >
          <span>{drag.preview.drop.label}</span>
        </div>
      )}
      <div className="fold-controls">
        {foldControls.map((control) => (
          <button
            key={control.id}
            type="button"
            className="fold-toggle"
            style={{ top: control.top }}
            aria-label={`${control.collapsed ? '展开' : '收起'}：${control.name}`}
            aria-expanded={!control.collapsed}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => toggleFold(control.id)}
          >
            {control.collapsed ? '▸' : '▾'}
          </button>
        ))}
      </div>
      <div
        id="card-body"
        className="paragraph-editor"
        ref={element}
        role="textbox"
        aria-label="卡片正文"
        aria-placeholder="输入文字，或用 / 插入"
        aria-multiline="true"
        aria-readonly={readOnly}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        onFocus={(event) => {
          document.execCommand('defaultParagraphSeparator', false, 'p');
          setActiveId(position(element.current!).blockId || blocks[0]!.id);
          const cell = (event.target as HTMLElement).dataset.cell;
          if (cell) {
            onFinish();
            setActiveCell(cell);
          }
        }}
        onPointerMove={(event) => {
          const block = (event.target as Element).closest<HTMLElement>('[data-block-id]');
          if (!menu && block) {
            const id = block.dataset.blockId!;
            // A hovered table has its own cell coordinates. Keep the selected
            // cell within a table, but never carry another table's range over.
            if (id !== activeId) {
              const cell = (event.target as Element).closest<HTMLElement>('[data-cell]');
              setActiveCell(cell?.dataset.cell ?? '0,0');
            }
            setActiveId(id);
          }
        }}
        onInput={(event) => {
          if (readOnly) return;
          if (selectFrame.current !== undefined) cancelAnimationFrame(selectFrame.current);
          const next = read(),
            p = position(event.currentTarget),
            id = p.blockId || next[0]!.id,
            block = next.find((b) => b.id === id)!;
          const previous = blocks.find((b) => b.id === id);
          emitted.current = JSON.stringify(next);
          setActiveId(id);
          onChange(next, (event.nativeEvent as InputEvent).inputType, {
            ...p,
            blockId: id,
          });
          const input = event.nativeEvent as InputEvent;
          if (
            !composing.current &&
            !input.isComposing &&
            input.inputType === 'insertText' &&
            input.data &&
            p.start === p.end
          ) {
            const start = p.start - input.data.length;
            const prior = typed.current;
            typed.current =
              prior?.blockId === id && prior.end === start
                ? { ...prior, end: p.start, text: prior.text + input.data }
                : { blockId: id, start, end: p.start, text: input.data };
            const run = typed.current;
            const replacement = markdownShortcut(block, run);
            if (replacement) {
              typed.current = null;
              const converted = next.map((b) => (b.id === id ? replacement : b));
              let point = {
                blockId: id,
                offset: p.start - (block.text!.length - (replacement.text?.length ?? 0)),
              };
              if (replacement.type === 'divider') {
                const following = blank();
                converted.splice(converted.findIndex((b) => b.id === id) + 1, 0, following);
                point = { blockId: following.id, offset: 0 };
              }
              apply(converted, point, 'formatMarkdown');
              return;
            }
          } else typed.current = null;
          if (
            block.type === 'text' &&
            block.text?.startsWith('/') &&
            ((previous?.type === 'text' && !previous.text) ||
              (menu?.mode === 'slash' && menu.id === id))
          ) {
            setMenu({
              id,
              signature: block,
              mode: 'slash',
              query: block.text.slice(1),
              index: 0,
              selection: selectionPoints(event.currentTarget),
            });
          } else if (menu?.mode === 'slash') setMenu(null);
        }}
        onSelect={() => {
          if (selectFrame.current !== undefined) cancelAnimationFrame(selectFrame.current);
          selectFrame.current = requestAnimationFrame(selected);
        }}
        onKeyUp={(event) => {
          if (!event.metaKey && !event.ctrlKey) selected();
        }}
        onPointerDown={(event) => {
          pointerStart.current = { x: event.clientX, y: event.clientY };
          interaction.current++;
          typed.current = null;
          setLinkTarget(null);
        }}
        onPointerUp={selected}
        onCompositionStart={() => {
          typed.current = null;
          pasteEpoch.current++;
          composing.current = true;
          onComposition(true);
        }}
        onCompositionEnd={() => {
          composing.current = false;
          onComposition(false);
        }}
        onBlur={onFinish}
        onPaste={(event) => {
          event.preventDefault();
          if (readOnly || composing.current) return;
          try {
            typed.current = null;
            const cursor = selectionPoints(event.currentTarget);
            if (read().find((b) => b.id === cursor?.start.blockId)?.type === 'code') {
              pasteText(event.clipboardData.getData('text/plain'), cursor);
              return;
            }
            const copied = clipboardBlocks(event.clipboardData.getData('text/html'));
            if (copied) {
              pasteBlocks(copied.blocks, copied.readonlyIds);
              return;
            }
            const files = Array.from(event.clipboardData.files).filter((file) =>
              file.type.startsWith('image/'),
            );
            if (files.length && cursor) {
              void pasteImages(
                files,
                cursor,
                event.clipboardData.getData('text/html'),
                event.clipboardData.getData('text/plain'),
              );
              return;
            }
            const html = event.clipboardData.getData('text/html');
            if (html && cursor) {
              const imported = htmlBlocks(html, event.clipboardData.getData('text/plain'));
              const replacement = replaceTextSelection(read(), cursor, imported.blocks);
              if (!replacement) {
                setNotice('此选区不能可靠粘贴，原文已保留');
                return;
              }
              setMenu(null);
              setFormatTarget(null);
              apply(replacement.blocks, replacement.point, 'insertFromPaste');
              if (imported.notice) setNotice(imported.notice);
              return;
            }
            pasteText(event.clipboardData.getData('text/plain'), cursor);
          } catch {
            setNotice('块剪贴板无法读取，原文已保留');
          }
        }}
        onClick={(event) => {
          const anchor = (event.target as Element).closest<HTMLAnchorElement>('a');
          if (anchor) {
            event.preventDefault();
            if (
              event.detail <= 1 &&
              Math.hypot(
                event.clientX - pointerStart.current.x,
                event.clientY - pointerStart.current.y,
              ) < 4
            )
              openLink(true, anchor);
          }
        }}
        onKeyDown={(event) => {
          const action = ++interaction.current;
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
          const codeSelection = selectionPoints(event.currentTarget);
          if (
            codeSelection &&
            read().find((b) => b.id === codeSelection.start.blockId)?.type === 'code' &&
            codeSelection.start.blockId === codeSelection.end.blockId
          ) {
            if (event.key === 'Tab') {
              event.preventDefault();
              const replacement = replaceTextSelection(
                read(),
                codeSelection,
                plainTextBlocks('  '),
              );
              if (replacement) apply(replacement.blocks, replacement.point, 'insertText');
              return;
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              paragraphAfter(codeSelection.start.blockId);
              return;
            }
          }
          const run = typed.current;
          if (event.key.length > 1 || event.metaKey || event.ctrlKey || event.altKey)
            typed.current = null;
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            run?.start === 0 &&
            /^(```|~~~)[\w+-]*$/.test(run.text)
          ) {
            const current = read(),
              block = current.find((b) => b.id === run.blockId);
            const cursor = selectionPoints(event.currentTarget);
            if (
              block?.type === 'text' &&
              block.text === run.text &&
              cursor?.start.blockId === block.id &&
              cursor.end.blockId === block.id &&
              cursor.start.offset === run.end &&
              cursor.end.offset === run.end
            ) {
              event.preventDefault();
              apply(
                current.map((b) =>
                  b === block
                    ? {
                        id: b.id,
                        inlineId: b.inlineId,
                        type: 'code',
                        text: '',
                        language: run.text.slice(3),
                        wrap: false,
                      }
                    : b,
                ),
                { blockId: block.id, offset: 0 },
                'formatMarkdown',
              );
              return;
            }
          }
          if (event.key === 'Tab') {
            const cursor = position(event.currentTarget),
              current = read();
            const selection = selectionPoints(event.currentTarget),
              table = current.find((b) => b.id === cursor.blockId);
            if (table?.type === 'table' && selection?.start.cell) {
              event.preventDefault();
              const rows = table.rows as TableCell[][],
                columns = rows[0]!.length;
              const [row, column] = selection.start.cell.split(',').map(Number);
              const index = row! * columns + column! + (event.shiftKey ? -1 : 1);
              if (index < 0) return;
              const cell = `${Math.floor(index / columns)},${index % columns}`;
              onFinish();
              setActiveCell(cell);
              if (index >= rows.length * columns)
                tableChange(
                  {
                    ...table,
                    rows: [...rows, rows[0]!.map(() => ({ text: '' }))],
                  },
                  cell,
                );
              else {
                restoreSelection(event.currentTarget, {
                  blockId: table.id,
                  offset: 0,
                  cell,
                });
                selected();
              }
              return;
            }
            if (current.find((b) => b.id === cursor.blockId)?.type === 'listItem') {
              event.preventDefault();
              const next = indentList(current, cursor.blockId, event.shiftKey);
              if (next !== current)
                apply(next, { blockId: cursor.blockId, offset: cursor.start }, 'indentList');
              return;
            }
          }
          if (menu) {
            menuKey(event);
            if (event.defaultPrevented) return;
          }
          if (
            (event.metaKey || event.ctrlKey) &&
            ['b', 'i', 'u', 'k'].includes(event.key.toLowerCase())
          ) {
            event.preventDefault();
            const type = ({ b: 'bold', i: 'italic', u: 'underline' } as const)[
              event.key.toLowerCase() as 'b' | 'i' | 'u'
            ];
            if (event.key.toLowerCase() === 'k') {
              openLink();
            } else format(type);
            return;
          }
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            ['z', 'y'].includes(event.key.toLowerCase())
          ) {
            event.preventDefault();
            const saved = selectionPoints(event.currentTarget);
            pendingHistorySelection.current = {
              action,
              selection: saved,
              wasBlocked: false,
              ready: false,
            };
            void onHistory(
              event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo',
            ).then(() => {
              const pending = pendingHistorySelection.current;
              if (pending?.action === action) {
                pending.ready = true;
                setHistorySelectionRevision((revision) => revision + 1);
              }
            });
            return;
          }
          if (event.key === 'Enter' && enter(event.shiftKey)) event.preventDefault();
          if (
            event.key === 'Backspace' &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            backspace()
          )
            event.preventDefault();
          if (event.key === 'Escape') {
            event.preventDefault();
            window.getSelection()?.removeAllRanges();
            (document.activeElement as HTMLElement | null)?.blur();
            event.currentTarget.blur();
            setActiveId('');
          }
        }}
      />
    </div>
  );
}
