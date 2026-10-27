import { useRef, useState } from "react";
import type { Command, ProjectState } from "./api";
import { canvasItems, selectedItemIds, type CanvasSelection } from './canvas-selection';
type Point = { x: number; y: number };
type Target = {
  kind: "card" | "text" | "shape" | "image" | "stroke";
  id: string;
  item: { id: string; versionId: string; pose: Point };
};
type Enqueue = (prepare: () => Promise<Command>, done: () => void) => void;
export function useCanvasMove(
  state: ProjectState | null,
  selection: CanvasSelection,
  enqueue: Enqueue,
) {
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const gesture = useRef<{
    projectId: string;
    targets: Target[];
    anchor: Target;
    command: Extract<Command, { type: 'canvas.move-selection' }> | null;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const ended = useRef(new Set<string>());
  const pointerSession = useRef<{
    id: string; state: ProjectState; selection: CanvasSelection; pointerWorld: Point; mouseWorld: Point | null; anchor: Point;
    phase: 'armed' | 'active' | 'cancelled' | 'terminal';
  } | null>(null);
  function start(id: string, pointer = false) {
    ended.current.clear();
    const captured = pointer && pointerSession.current?.id === id ? pointerSession.current : null;
    if (captured) captured.phase = 'active';
    if (!pointer) pointerSession.current = null;
    const snapshot = captured?.state ?? state, selected = captured?.selection ?? selection;
    if (!snapshot || gesture.current) return false;
    const ids = selectedItemIds(snapshot, selected);
    if (!ids.includes(id)) return false;
    const targets: Target[] = [
      ...snapshot.cards.map((card) => ({
        kind: "card" as const,
        id: card.id,
        item: card.item,
      })),
      ...(snapshot.texts ?? []).map((text) => ({
        kind: "text" as const,
        id: text.id,
        item: text.item,
      })),
      ...(snapshot.shapes ?? []).map((shape) => ({
        kind: "shape" as const,
        id: shape.id,
        item: shape.item,
      })),
      ...(snapshot.images ?? []).map(image => ({ kind: 'image' as const, id: image.id, item: image.item })),
      ...(snapshot.strokes ?? []).map(stroke => ({ kind: 'stroke' as const, id: stroke.id, item: stroke.item })),
    ].filter((value) => ids.includes(value.item.id)).map(value => ({ ...value, item: structuredClone(value.item) }));
    const anchor = targets.find((value) => value.item.id === id);
    const grouped = selected.targets.some(t => t.kind === 'group') || targets.some(t => snapshot.containment?.some(c => c.id === t.item.id));
    if (
      !anchor ||
      (!grouped && targets.length < 2 && anchor.kind !== 'image' && anchor.kind !== 'stroke') ||
      targets.length !== ids.length ||
      (!grouped && !targets.some((value) => value.kind !== 'card'))
    )
      return false;
    const command: Extract<Command, { type: 'canvas.move-selection' }> | null = grouped || targets.some(t => t.kind === 'stroke')
      ? { commandId: crypto.randomUUID(), projectId: snapshot.project.id, type: 'canvas.move-selection',
        expected: { groups: Object.fromEntries(selected.targets.flatMap(t => t.kind === 'group' ? [[t.id, snapshot.groups!.find(g => g.id === t.id)!.versionId]] : [])),
          containment: Object.fromEntries(ids.map(itemId => [itemId, snapshot.containment?.find(c => c.id === itemId)?.versionId ?? null])),
          poses: Object.fromEntries(targets.map(t => [t.item.id, t.item.versionId])) },
        payload: { groupIds: selected.targets.flatMap(t => t.kind === 'group' ? [t.id] : []), directItemIds: selected.targets.flatMap(t => t.kind === 'item' ? [t.itemId] : []), dx: 0, dy: 0 } }
      : null;
    gesture.current = { projectId: snapshot.project.id, targets, anchor, command };
    setDragging(true);
    return true;
  }
  function preview(id: string, _point: Point) {
    if (ended.current.has(id)) return true;
    if (!gesture.current?.targets.some((value) => value.item.id === id))
      return false;
    // The engine's position proposals omit motion before its drag threshold.
    // This owner derives all active member positions from the original pointer.
    return true;
  }
  function drag(point: Point) {
    const current = gesture.current;
    if (!current) return ended.current.size > 0;
    const dx = point.x - current.anchor.item.pose.x, dy = point.y - current.anchor.item.pose.y;
    setPositions(
      Object.fromEntries(
        current.targets.map((value) => [
          value.item.id,
          { x: value.item.pose.x + dx, y: value.item.pose.y + dy },
        ]),
      ),
    );
    return true;
  }
  function finish(point: Point) {
    const current = gesture.current;
    if (!current) return ended.current.size > 0;
    const dx = point.x - current.anchor.item.pose.x, dy = point.y - current.anchor.item.pose.y;
    ended.current = new Set(current.targets.map(value => value.item.id));
    gesture.current = null;
    setDragging(false);
    if (!dx && !dy) {
      setPositions({});
      return true;
    }
    enqueue(
      async () => current.command ? { ...current.command, payload: { ...current.command.payload, dx, dy } } : ({
        commandId: crypto.randomUUID(),
        projectId: current.projectId,
        type: "canvas.move",
        expected: Object.fromEntries(
          current.targets.map((value) => [value.item.id, value.item.versionId]),
        ),
        payload: {
          targets: current.targets.map((value) => ({
            kind: value.kind,
            id: value.id,
            itemId: value.item.id,
            x: value.item.pose.x + dx,
            y: value.item.pose.y + dy,
          })),
        },
      }),
      () => setPositions({}),
    );
    return true;
  }
  function cancel() {
    if (pointerSession.current) pointerSession.current.phase = 'cancelled';
    if (gesture.current) ended.current = new Set(gesture.current.targets.map(value => value.item.id));
    gesture.current = null;
    setDragging(false);
    setPositions({});
  }
  return { start, preview, drag, finish, cancel, positions, dragging,
    arm(id: string, source: ProjectState, roots: CanvasSelection, pointerWorld: Point) {
      const snapshot = structuredClone(source), anchor = canvasItems(snapshot).find(value => value.item.id === id);
      ended.current.clear();
      pointerSession.current = anchor ? { id, state: snapshot, selection: structuredClone(roots), pointerWorld,
        mouseWorld: null, anchor: { x: anchor.item.pose.x, y: anchor.item.pose.y }, phase: 'armed' } : null;
    },
    mouseOrigin(id: string, world: Point) {
      const session = pointerSession.current;
      if (session?.id === id && session.phase === 'armed' && !session.mouseWorld) session.mouseWorld = world;
    },
    point(id: string, fallback: Point, world?: Point, touchInput = false) {
      const session = pointerSession.current;
      const origin = touchInput ? session?.pointerWorld : session?.mouseWorld;
      return session?.id === id && world && origin
        ? { x: session.anchor.x + (world.x - origin.x), y: session.anchor.y + (world.y - origin.y) }
        : fallback;
    },
    consumesPosition: () => !!pointerSession.current,
    pointerEnded: (id: string) => pointerSession.current?.id === id && ['cancelled', 'terminal'].includes(pointerSession.current.phase),
    endPointer() { if (pointerSession.current) pointerSession.current.phase = 'terminal'; },
  };
}
