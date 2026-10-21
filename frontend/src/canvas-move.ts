import { useRef, useState } from "react";
import type { Command, ProjectState } from "./api";
type Point = { x: number; y: number };
type Target = {
  kind: "card" | "text";
  id: string;
  item: { id: string; versionId: string; pose: Point };
};
type Enqueue = (prepare: () => Promise<Command>, done: () => void) => void;
export function useCanvasMove(
  state: ProjectState | null,
  selection: string[],
  enqueue: Enqueue,
) {
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const gesture = useRef<{
    projectId: string;
    targets: Target[];
    anchor: Target;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  function start(id: string) {
    if (!state || gesture.current || !selection.includes(id)) return false;
    const targets: Target[] = [
      ...state.cards.map((card) => ({
        kind: "card" as const,
        id: card.id,
        item: card.item,
      })),
      ...(state.texts ?? []).map((text) => ({
        kind: "text" as const,
        id: text.id,
        item: text.item,
      })),
    ].filter((value) => selection.includes(value.item.id));
    const anchor = targets.find((value) => value.item.id === id);
    if (
      !anchor ||
      targets.length < 2 ||
      !targets.some((value) => value.kind === "text")
    )
      return false;
    gesture.current = { projectId: state.project.id, targets, anchor };
    setDragging(true);
    return true;
  }
  function preview(id: string, point: Point) {
    if (!gesture.current?.targets.some((value) => value.item.id === id))
      return false;
    setPositions((previous) => ({ ...previous, [id]: point }));
    return true;
  }
  function drag(point: Point) {
    const current = gesture.current;
    if (!current) return false;
    const dx = point.x - current.anchor.item.pose.x,
      dy = point.y - current.anchor.item.pose.y;
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
    if (!current) return false;
    gesture.current = null;
    setDragging(false);
    const dx = point.x - current.anchor.item.pose.x,
      dy = point.y - current.anchor.item.pose.y;
    if (!dx && !dy) {
      setPositions({});
      return true;
    }
    enqueue(
      async () => ({
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
    gesture.current = null;
    setDragging(false);
    setPositions({});
  }
  return { start, preview, drag, finish, cancel, positions, dragging };
}
