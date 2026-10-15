import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Block } from '../../backend/src/mapping/contracts';
import {
  listDepth,
  listEnd,
  validListStructure,
  withListParent,
} from '../../backend/src/mapping/list-structure';

type Drop = {
  index: number;
  parentId?: string;
  top: number;
  left: number;
  width: number;
  label: string;
};
type Gesture = {
  pointer: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  source: Block[];
  ids: string[];
  moving: boolean;
  drop: Drop | null;
};
function moved(gesture: Gesture, drop: Drop): Block[] | null {
  const { source, ids } = gesture;
  const first = source.findIndex((b) => b.id === ids[0]);
  if (
    first < 0 ||
    ids.includes(drop.parentId ?? '') ||
    !ids.every((id, i) => source[first + i]?.id === id) ||
    (drop.index > first && drop.index < first + ids.length)
  )
    return null;
  const roots = source
    .slice(first, first + ids.length)
    .filter((b) => !ids.includes(b.parentId as string));
  if (drop.parentId && roots.some((b) => b.type !== 'listItem')) return null;
  const next = source.filter((b) => !ids.includes(b.id));
  const group = source
    .slice(first, first + ids.length)
    .map((b) => (roots.includes(b) ? withListParent(b, drop.parentId) : b));
  next.splice(drop.index > first ? drop.index - ids.length : drop.index, 0, ...group);
  return validListStructure(next) && JSON.stringify(next) !== JSON.stringify(source)
    ? next
    : null;
}

// Preview owns no content writes. Only a valid pointer-up emits one completed action.
export function useBlockDrag(options: {
  editor: RefObject<HTMLDivElement | null>;
  blocks: Block[];
  disabled: boolean;
  read: () => Block[];
  selected: () => Block[] | undefined;
  start: () => void;
  commit: (blocks: Block[], id: string) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<{
    ids: string[];
    drop: Drop | null;
  } | null>(null);
  const cancel = useRef(() => {});
  useEffect(() => {
    let frame = 0;
    function clear() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      gesture.current = null;
      setPreview(null);
    }
    cancel.current = clear;
    function update() {
      const g = gesture.current,
        editor = latest.current.editor.current;
      if (!g?.moving || !editor) return;
      const rect = editor.getBoundingClientRect();
      const scroll = editor.closest<HTMLElement>('.board-scroll');
      const clip = scroll?.getBoundingClientRect() ?? rect;
      g.drop = null;
      if (
        g.x >= rect.left &&
        g.x <= rect.right &&
        g.y >= Math.max(rect.top, clip.top) &&
        g.y <= Math.min(rect.bottom, clip.bottom)
      ) {
        const visible = Array.from(editor.children).filter(
          (node): node is HTMLElement => node instanceof HTMLElement && !node.hidden,
        );
        const node =
          visible.find((node) => g.y < node.getBoundingClientRect().bottom) ?? visible.at(-1);
        if (node) {
          const box = node.getBoundingClientRect();
          let index = g.source.findIndex((b) => b.id === node.dataset.blockId);
          let target = g.source[index]!;
          const after = g.y >= (box.top + box.bottom) / 2;
          const desired = Math.max(0, Math.floor((g.x - rect.left) / 24));
          while (target.parentId && listDepth(g.source, target) > desired) {
            index = g.source.findIndex((b) => b.id === target.parentId);
            target = g.source[index]!;
          }
          const child =
            after && target.type === 'listItem' && desired > listDepth(g.source, target);
          const parentId = child ? target.id : (target.parentId as string | undefined);
          const depth = child ? listDepth(g.source, target) + 1 : listDepth(g.source, target);
          const parent = g.source.find((b) => b.id === parentId);
          const drop: Drop = {
            index: after ? listEnd(g.source, index) : index,
            ...(parentId ? { parentId } : {}),
            top: after ? box.bottom : box.top,
            left: rect.left + depth * 24,
            width: Math.max(24, rect.width - depth * 24),
            label: `移到第 ${depth + 1} 层${parent ? ` · 父项：${parent.text || '空条目'}` : ''}`,
          };
          if (moved(g, drop)) g.drop = drop;
        }
        if (scroll) {
          const delta = g.y < clip.top + 44 ? -14 : g.y > clip.bottom - 44 ? 14 : 0;
          if (delta) scroll.scrollTop += delta;
        }
      }
      setPreview({ ids: g.ids, drop: g.drop });
    }
    function tick() {
      update();
      if (gesture.current?.moving) frame = requestAnimationFrame(tick);
    }
    function move(event: PointerEvent) {
      const g = gesture.current;
      if (!g || event.pointerId !== g.pointer) return;
      if (latest.current.disabled || event.buttons !== 1) {
        clear();
        return;
      }
      g.x = event.clientX;
      g.y = event.clientY;
      if (!g.moving && Math.hypot(g.x - g.startX, g.y - g.startY) >= 6) {
        g.moving = true;
        suppressClick.current = true;
        latest.current.start();
        frame = requestAnimationFrame(tick);
      }
      if (g.moving) {
        event.preventDefault();
        update();
      }
    }
    function up(event: PointerEvent) {
      const g = gesture.current;
      if (!g || event.pointerId !== g.pointer) return;
      g.x = event.clientX;
      g.y = event.clientY;
      if (g.moving) update();
      const next = g.moving && g.drop ? moved(g, g.drop) : null;
      clear();
      if (
        next &&
        !latest.current.disabled &&
        JSON.stringify(latest.current.read()) === JSON.stringify(g.source)
      )
        latest.current.commit(next, g.ids[0]!);
    }
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape' && gesture.current) {
        event.preventDefault();
        event.stopPropagation();
        clear();
      }
    }
    function visibility() {
      if (document.hidden) clear();
    }
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', clear);
    document.addEventListener('keydown', key, true);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', clear);
    return () => {
      clear();
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', clear);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', clear);
    };
  }, []);
  useEffect(() => {
    if (options.disabled) cancel.current();
  }, [options.disabled]);
  return {
    preview,
    begin(event: React.PointerEvent, id: string) {
      if (event.button !== 0 || latest.current.disabled) return;
      const source = latest.current.read(),
        index = source.findIndex((b) => b.id === id);
      if (index < 0) return;
      const selected = latest.current.selected();
      const ids = selected?.some((b) => b.id === id)
        ? selected.map((b) => b.id)
        : source.slice(index, listEnd(source, index)).map((b) => b.id);
      suppressClick.current = false;
      gesture.current = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        source,
        ids,
        moving: false,
        drop: null,
      };
      event.preventDefault();
    },
    consumeClick() {
      const value = suppressClick.current;
      suppressClick.current = false;
      return value;
    },
  };
}
