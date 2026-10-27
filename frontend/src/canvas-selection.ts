import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectState } from './api';

export type SelectionTarget = { kind: 'group'; id: string } | { kind: 'item'; itemId: string };
export type CanvasSelection = { targets: SelectionTarget[]; enteredGroupId: string | null };
const empty: CanvasSelection = { targets: [], enteredGroupId: null };
export function canvasItems(state: ProjectState) {
  return [...state.cards, ...(state.texts ?? []), ...(state.shapes ?? []), ...(state.images ?? []), ...(state.strokes ?? [])]
    .sort((a, b) => (a.item.createdOrder ?? 0) - (b.item.createdOrder ?? 0));
}
export function selectedItemIds(state: ProjectState, selection: CanvasSelection) {
  return [...new Set(selection.targets.flatMap(target => target.kind === 'item' ? [target.itemId]
    : state.groups?.find(group => group.id === target.id)?.memberItemIds ?? []))];
}
function normalize(state: ProjectState, value: CanvasSelection): CanvasSelection {
  const groups = new Set(value.targets.filter(t => t.kind === 'group').map(t => t.id));
  const covered = new Set(state.groups?.filter(g => groups.has(g.id)).flatMap(g => g.memberItemIds));
  const live = new Set(canvasItems(state).map(v => v.item.id)), seen = new Set<string>();
  return { enteredGroupId: state.groups?.some(g => g.id === value.enteredGroupId) ? value.enteredGroupId : null,
    targets: value.targets.filter(t => {
      const key = t.kind === 'group' ? 'g:' + t.id : 'i:' + t.itemId;
      const valid = t.kind === 'group' ? state.groups?.some(g => g.id === t.id) : live.has(t.itemId) && !covered.has(t.itemId);
      if (!valid || seen.has(key)) return false;
      seen.add(key); return true;
    }) };
}
export function useCanvasSelection(state: ProjectState | null) {
  const [value, setValue] = useState<CanvasSelection>(empty), current = useRef(value), project = useRef(state?.project.id);
  const pointer = useRef<{ id: string; state: ProjectState; before: CanvasSelection; drag: CanvasSelection; dragged: boolean; finished: boolean } | null>(null);
  const generation = useRef(0);
  function set(next: CanvasSelection) { generation.current++; current.current = next; setValue(next); }
  useEffect(() => {
    const next = project.current !== state?.project.id ? empty : state ? normalize(state, current.current) : empty;
    project.current = state?.project.id;
    if (JSON.stringify(next) !== JSON.stringify(current.current)) set(next);
  }, [state]);
  const directItemIds = useMemo(() => value.targets.flatMap(t => t.kind === 'item' ? [t.itemId] : []), [value]);
  const flowSelectedItemIds = useMemo(() => state ? selectedItemIds(state, value) : [], [state, value]);
  function hit(itemId: string): SelectionTarget {
    const group = state?.groups?.find(g => g.memberItemIds.includes(itemId));
    return group && current.current.enteredGroupId !== group.id ? { kind: 'group', id: group.id } : { kind: 'item', itemId };
  }
  function choose(itemId: string, extend: boolean) {
    if (!state) return;
    const target = hit(itemId), old = current.current;
    if (!extend && target.kind === 'group' && old.targets.some(t => t.kind === 'group' && t.id === target.id)) {
      set({ targets: [{ kind: 'item', itemId }], enteredGroupId: target.id }); return;
    }
    set(normalize(state, { targets: extend ? [...old.targets, target] : [target], enteredGroupId: old.enteredGroupId }));
  }
  return { value, directItemIds, flowSelectedItemIds, set, choose, current: () => current.current,
    generation: () => generation.current,
    reconcile(next: ProjectState, sameProject: boolean) {
      const normalized = sameProject ? normalize(next, current.current) : empty;
      project.current = next.project.id;
      if (JSON.stringify(normalized) !== JSON.stringify(current.current)) set(normalized);
    },
    setItems(next: string[] | ((previous: string[]) => string[])) {
      const previous = current.current.targets.flatMap(t => t.kind === 'item' ? [t.itemId] : []);
      const ids = typeof next === 'function' ? next(previous) : next;
      set({ targets: [...new Set(ids)].map(itemId => ({ kind: 'item', itemId })), enteredGroupId: ids.length ? current.current.enteredGroupId : null });
    },
    capture(id: string, extend: boolean) {
      if (!state) return null;
      const before = structuredClone(current.current), selected = selectedItemIds(state, before).includes(id);
      const drag = selected ? before : normalize(state, { targets: extend ? [...before.targets, hit(id)] : [hit(id)], enteredGroupId: before.enteredGroupId });
      pointer.current = { id, state, before, drag, dragged: false, finished: false };
      return { state, selection: drag };
    },
    beginDrag(id: string) { const p = pointer.current; if (p?.id === id) { p.dragged = true; set(p.drag); } },
    finishDrag() { if (pointer.current) pointer.current.finished = true; },
    cancelDrag() { const p = pointer.current; if (p?.dragged && !p.finished) { set(p.before); p.finished = true; } },
    consumeClick(id: string, extend: boolean) {
      if (pointer.current?.dragged) return true;
      if (state?.groups?.some(g => g.memberItemIds.includes(id))) { choose(id, extend); return true; }
      return false;
    },
    marquee(ids: string[], previous: CanvasSelection, extend: boolean) {
      if (!state) return;
      const contained = new Set(ids), targets: SelectionTarget[] = [];
      const outside = (state.groups ?? []).filter(g => g.id !== previous.enteredGroupId);
      for (const group of outside) if (group.memberItemIds.every(id => contained.has(id))) targets.push({ kind: 'group', id: group.id });
      for (const itemId of ids) if (!outside.some(g => g.memberItemIds.includes(itemId))) targets.push({ kind: 'item', itemId });
      set(normalize(state, { targets: extend ? [...previous.targets, ...targets] : targets, enteredGroupId: previous.enteredGroupId }));
    },
  };
}
