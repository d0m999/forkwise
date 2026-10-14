import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Block } from '../../backend/src/mapping/contracts';
import { plainParagraph } from '../../backend/src/mapping/body-text';
import {
  editableBlock,
  editableTextBlock,
  type InlineMark,
} from '../../backend/src/mapping/general-blocks';
import { BlockMenu, BLOCK_OPTIONS } from './block-menu';
import { InlineToolbar } from './inline-toolbar';
import { CardIcon } from './card-icons';
import {
  blockText,
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
};
type FormatTarget = {
  selection: Selection;
  originals: Block[];
  left: number;
  top: number;
  link?: boolean;
};
function blank(): Block {
  return { id: crypto.randomUUID(), type: 'text', text: '', inlineId: crypto.randomUUID() };
}
function position(editor: HTMLElement): TextCursor {
  const p = selectionPoints(editor);
  return { blockId: p?.start.blockId ?? '', start: p?.start.offset ?? 0, end: p?.end.offset ?? 0 };
}
function convert(block: Block, shape: Partial<Block>): Block {
  return {
    id: block.id,
    type: shape.type!,
    text: block.text ?? '',
    ...(block.inlineId ? { inlineId: block.inlineId } : {}),
    ...(block.marks ? { marks: block.marks } : {}),
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
  blocks,
  readOnly,
  onChange,
  onSelect,
  onComposition,
  onFinish,
  onHistory,
}: {
  blocks: Block[];
  readOnly: boolean;
  onChange: (blocks: Block[], inputType: string, cursor: TextCursor) => void;
  onSelect: (cursor: TextCursor) => void;
  onComposition: (value: boolean) => void;
  onFinish: () => void;
  onHistory: (direction: 'undo' | 'redo') => Promise<void>;
}) {
  const element = useRef<HTMLDivElement>(null),
    wrapper = useRef<HTMLDivElement>(null);
  const composing = useRef(false),
    emitted = useRef('');
  const nativeIds = useRef(new WeakMap<Node, { id: string; inlineId: string }>());
  const selectFrame = useRef<number | undefined>(undefined);
  const interaction = useRef(0);
  const [activeId, setActiveId] = useState(''),
    [menu, setMenu] = useState<Menu | null>(null);
  const [notice, setNotice] = useState('');
  const [formatTarget, setFormatTarget] = useState<FormatTarget | null>(null);
  const supported = blocks.every(editableBlock);
  function read(): Block[] {
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
    let ordinal = 0;
    editor.replaceChildren(
      ...next.map((block) => {
        const p = renderBlock(block);
        ordinal = block.listType === 'ordered' ? ordinal + 1 : 0;
        if (ordinal) p.dataset.ordinal = String(ordinal);
        nativeIds.current.set(p, { id: block.id, inlineId: p.dataset.inlineId! });
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
    if (readOnly && element.current?.contains(document.activeElement)) {
      element.current.blur();
      window.getSelection()?.removeAllRanges();
    }
    if (readOnly && menu) {
      setMenu(null);
      setNotice('原目标已失效，操作已取消');
    }
  }, [readOnly]);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => {
      if (
        !composing.current &&
        e.target instanceof Node &&
        !wrapper.current?.querySelector('.block-menu')?.contains(e.target)
      )
        setMenu(null);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [menu]);
  function apply(next: Block[], start: BlockPoint, inputType: string, end = start) {
    if (readOnly || composing.current) return;
    const editor = element.current!;
    onFinish();
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
    onSelect(p);
    if (document.activeElement?.closest('.inline-toolbar, .block-menu')) return;
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
  function format(type: InlineMark['type'], value?: string) {
    if (!formatTarget || readOnly || composing.current) return;
    const next = read(),
      { selection, originals } = formatTarget;
    if (!matchesTarget(next, formatTarget)) {
      setFormatTarget(null);
      setNotice('原文字选区已失效，操作已取消');
      return;
    }
    const first = next.findIndex((b) => b.id === selection.start.blockId),
      last = next.findIndex((b) => b.id === selection.end.blockId);
    if (first < 0 || last < first || !next.slice(first, last + 1).every(editableTextBlock)) {
      setFormatTarget(null);
      setNotice('原文字选区已失效，操作已取消');
      return;
    }
    const ranges = next
      .slice(first, last + 1)
      .map((b, i) => ({
        block: b,
        start: i ? 0 : selection.start.offset,
        end: i === last - first ? selection.end.offset : b.text!.length,
      }));
    const remove = ranges.every(({ block, start, end }) => {
      let covered = start;
      for (const m of ((block.marks ?? []) as InlineMark[])
        .filter((m) => m.type === type && (value === undefined || m.value === value))
        .sort((a, b) => a.start - b.start))
        if (m.start <= covered) covered = Math.max(covered, m.end);
      return covered >= end;
    });
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
      next[next.findIndex((b) => b.id === block.id)] = {
        ...rest,
        ...(marks.length ? { marks } : {}),
      };
    }
    apply(next, selection.start, 'formatInline', selection.end);
    const actual = read();
    setFormatTarget({ ...formatTarget, originals: actual.slice(first, last + 1) });
  }
  function openMenu(mode: Menu['mode'], id = activeId) {
    if (readOnly || composing.current) return;
    const block = read().find((b) => b.id === id);
    if (!block || (mode === 'convert' && !editableTextBlock(block))) return;
    onFinish();
    setNotice('');
    setFormatTarget(null);
    setMenu({
      id,
      signature: block,
      mode,
      query: '',
      index: 0,
      selection: selectionPoints(element.current!),
    });
  }
  const options = BLOCK_OPTIONS.filter(
    (o) =>
      (menu?.mode !== 'convert' || o.shape.type !== 'divider') &&
      o.name.includes(menu?.query ?? ''),
  );
  function choose(index: number) {
    if (!menu || composing.current || readOnly) return;
    const option = options[index];
    if (!option) return;
    const next = read(),
      i = next.findIndex((b) => b.id === menu.id),
      block = next[i];
    setMenu(null);
    if (!block || !sameBlock(menu.signature, block)) {
      setNotice('原目标已失效，操作已取消');
      return;
    }
    const reuse = menu.mode !== 'insert' || (block.type === 'text' && !block.text);
    let target = convert(reuse ? block : blank(), option.shape);
    if (menu.mode === 'slash')
      target = convert({ ...block, text: '', marks: undefined }, option.shape);
    if (target.type === 'divider')
      target = {
        id: target.id,
        type: 'divider',
        ...(target.inlineId ? { inlineId: target.inlineId } : {}),
      };
    if (menu.mode === 'convert' && sameBlock(block, target)) {
      element.current!.focus();
      if (menu.selection)
        restoreSelection(element.current!, menu.selection.start, menu.selection.end);
      return;
    }
    next.splice(reuse ? i : i + 1, reuse ? 1 : 0, target);
    let point = {
      blockId: target.id,
      offset:
        menu.mode === 'convert' ? (menu.selection?.start.offset ?? target.text?.length ?? 0) : 0,
    };
    if (target.type === 'divider') {
      const following = blank();
      next.splice((reuse ? i : i + 1) + 1, 0, following);
      point = { blockId: following.id, offset: 0 };
    }
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
    const next = read(),
      i = next.findIndex((b) => b.id === selection.start.blockId),
      block = next[i];
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
    if (block.type === 'listItem' && !block.text) {
      next[i] = convert(block, { type: 'text' });
      apply(next, { blockId: block.id, offset: 0 }, 'formatBlock');
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
    next.splice(i, 1, before, following);
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
    const next = read(),
      i = next.findIndex((b) => b.id === selection.start.blockId),
      block = next[i];
    if (!block || !editableTextBlock(block)) return false;
    if (block.type !== 'text') {
      next[i] = convert(block, { type: 'text' });
      apply(next, selection.start, 'formatBlock');
      return true;
    }
    const previous = next[i - 1];
    if (!previous || !editableTextBlock(previous)) return true;
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
  if (!supported)
    return (
      <section className="original-body" aria-label="只读正文原件">
        <p>此正文包含尚不支持的内容，原件只读保留。</p>
        {blocks.map((block) => (
          <section key={block.id} data-block-id={block.id}>
            <h3>原件：{block.type}</h3>
            <pre>{plainParagraph(block) ? block.text : JSON.stringify(block, null, 2)}</pre>
          </section>
        ))}
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
      {formatTarget && !readOnly && !menu && (
        <InlineToolbar
          onFormat={format}
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
          style={{ top: (anchor?.top ?? 0) - (wrapper.current?.getBoundingClientRect().top ?? 0) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button type="button" aria-label="插入块" onClick={() => openMenu('insert')}>
            ＋
          </button>
          {active && editableTextBlock(active) && (
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
        />
      )}
      {notice && <p role="alert">{notice}</p>}
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
        onFocus={() => {
          document.execCommand('defaultParagraphSeparator', false, 'p');
          setActiveId(position(element.current!).blockId || blocks[0]!.id);
        }}
        onPointerMove={(event) => {
          const block = (event.target as Element).closest<HTMLElement>('[data-block-id]');
          if (!menu && block) setActiveId(block.dataset.blockId!);
        }}
        onInput={(event) => {
          if (selectFrame.current !== undefined) cancelAnimationFrame(selectFrame.current);
          const next = read(),
            p = position(event.currentTarget),
            id = p.blockId || next[0]!.id,
            block = next.find((b) => b.id === id)!;
          const previous = blocks.find((b) => b.id === id);
          emitted.current = JSON.stringify(next);
          setActiveId(id);
          onChange(next, (event.nativeEvent as InputEvent).inputType, { ...p, blockId: id });
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
        onPointerDown={() => {
          interaction.current++;
        }}
        onPointerUp={selected}
        onCompositionStart={() => {
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
          document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
        }}
        onClick={(event) => {
          if ((event.target as Element).closest('a')) event.preventDefault();
        }}
        onKeyDown={(event) => {
          const action = ++interaction.current;
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
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
              if (formatTarget) setFormatTarget({ ...formatTarget, link: true });
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
            void onHistory(
              event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo',
            ).then(() =>
              requestAnimationFrame(() => {
                const editor = element.current;
                if (!editor?.isConnected || interaction.current !== action) return;
                editor.focus();
                const current = read(),
                  point =
                    saved && current.some((b) => b.id === saved.start.blockId)
                      ? saved.start
                      : { blockId: current.at(-1)!.id, offset: current.at(-1)!.text?.length ?? 0 };
                restoreSelection(
                  editor,
                  point,
                  saved && current.some((b) => b.id === saved.end.blockId) ? saved.end : point,
                );
                selected();
              }),
            );
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
            event.currentTarget.blur();
            setActiveId('');
          }
        }}
      />
    </div>
  );
}
