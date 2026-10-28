import { useRef, useState } from "react";
import type { Command, ProjectState } from "./api";
import { canvasItems, selectedItemIds, type CanvasSelection } from './canvas-selection';
import type { CanvasMoveIntent } from './canvas-move-conflict';
type Point = { x: number; y: number };
type Target = {
  kind: "card" | "text" | "shape" | "image" | "stroke";
  id: string;
  item: { id: string; versionId: string; pose: Point & { width: number; height: number; rotation?: number } };
};
type Enqueue = (prepare: () => Promise<Command>, done: () => void, intent: CanvasMoveIntent, discard: () => void) => void;
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
    clientOrigin: Point; mouseClient: Point | null; threshold: number; cancelledClickConsumed: boolean;
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
    const grouped = selected.targets.some(t => t.kind === 'group') || targets.some(t => snapshot.groups?.some(group => group.memberItemIds.includes(t.item.id)));
    if (
      !anchor ||
      (!grouped && targets.length < 2 && anchor.kind !== 'image') ||
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
      { targets: current.targets.map(value => ({ kind: value.kind, id: value.id, itemId: value.item.id,
        poseVersionId: value.item.versionId, pose: structuredClone(value.item.pose), x: value.item.pose.x + dx, y: value.item.pose.y + dy })) },
      () => setPositions({}),
    );
    return true;
  }
  function cancel() {
    if (pointerSession.current && pointerSession.current.phase !== 'terminal') pointerSession.current.phase = 'cancelled';
    if (gesture.current) ended.current = new Set(gesture.current.targets.map(value => value.item.id));
    gesture.current = null;
    setDragging(false);
    setPositions({});
  }
  return { start, preview, drag, finish, cancel, positions, dragging,
    arm(id: string, source: ProjectState, roots: CanvasSelection, pointerWorld: Point, clientOrigin: Point) {
      const snapshot = structuredClone(source), anchor = canvasItems(snapshot).find(value => value.item.id === id);
      const ids = selectedItemIds(snapshot, roots);
      const grouped = roots.targets.some(target => target.kind === 'group') || snapshot.groups?.some(group => group.memberItemIds.some(itemId => ids.includes(itemId)));
      const composite = ids.length > 1 && ids.some(itemId => !snapshot.cards.some(card => card.item.id === itemId));
      ended.current.clear();
      pointerSession.current = anchor ? { id, state: snapshot, selection: structuredClone(roots), pointerWorld,
        mouseWorld: null, mouseClient: null, anchor: { x: anchor.item.pose.x, y: anchor.item.pose.y }, clientOrigin,
        threshold: grouped || composite ? 3 : 0, cancelledClickConsumed: false, phase: 'armed' } : null;
    },
    pointerGate(id: string, event: MouseEvent | TouchEvent) {
      const session = pointerSession.current;
      if (!session || session.id !== id) return 'ordinary';
      if (session.phase === 'active') return 'active';
      const point = 'touches' in event ? event.touches[0] ?? event.changedTouches[0] : event;
      const origin = 'touches' in event ? session.clientOrigin : session.mouseClient;
      return point && origin && Math.hypot(point.clientX - origin.x, point.clientY - origin.y) > session.threshold
        ? 'activate' : 'armed';
    },
    pointerArmed: (id: string) => pointerSession.current?.id === id && pointerSession.current.phase === 'armed',
    hasPointerGesture: () => !!pointerSession.current && ['armed', 'active'].includes(pointerSession.current.phase),
    consumeCancelledClick() {
      const session = pointerSession.current;
      if (session?.phase !== 'cancelled' || session.cancelledClickConsumed) return false;
      session.cancelledClickConsumed = true;
      return true;
    },
    retirePointer() {
      if (pointerSession.current && ['cancelled', 'terminal'].includes(pointerSession.current.phase)) pointerSession.current = null;
    },
    mouseOrigin(id: string, world: Point, client: Point) {
      const session = pointerSession.current;
      if (session?.id === id && session.phase === 'armed' && !session.mouseWorld) {
        session.mouseWorld = world; session.mouseClient = client;
      }
    },
    touchOrigin(id: string, world: Point, client: Point) {
      const session = pointerSession.current;
      if (session?.id === id && session.phase === 'armed') {
        session.pointerWorld = world; session.clientOrigin = client;
      }
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
    endArmedPointer() { if (pointerSession.current?.phase === 'armed') pointerSession.current.phase = 'terminal'; },
  };
}
