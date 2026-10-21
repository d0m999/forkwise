import { useRef, useState, type PointerEvent } from "react";
import type { Command } from "../../backend/src/mapping/contracts";
import type { CanvasStroke } from "../../backend/src/mapping/stroke-contracts";
import type { PenKind } from "./stroke-tools";

type Point = { x: number; y: number };
type Draft = { projectId: string; penKind: PenKind; points: Point[] };
// Engineering initial styles. D405 does not prescribe these numeric defaults.
const styles = {
  pen: { color: "#403b36", width: 2, opacity: 1 },
  highlighter: { color: "#f4e9b9", width: 10, opacity: 0.4 },
};

function projection(draft: Draft): Pick<CanvasStroke, "content"> & { pose: CanvasStroke["item"]["pose"] } {
  const style = styles[draft.penKind];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of draft.points) {
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
  }
  const x = minX - style.width / 2, y = minY - style.width / 2;
  return {
    content: { penKind: draft.penKind, ...style, path: draft.points.map(point => ({ x: point.x - x, y: point.y - y })) },
    pose: { x, y, width: maxX - x + style.width / 2, height: maxY - y + style.width / 2 },
  };
}

export function useStrokeDraw({ projectId, blocked, point, commit }: {
  projectId: () => string | undefined; blocked: () => boolean;
  point: (client: Point) => Point; commit: (command: Command, done: () => void) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<PenKind | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const active = useRef<{ value: Draft; pointerId: number; element: HTMLElement } | null>(null);
  const saving = useRef(false);
  function append(event: PointerEvent<HTMLElement>) {
    const session = active.current;
    if (!session || session.pointerId !== event.pointerId || session.value.projectId !== projectId()) return;
    const next = point({ x: event.clientX, y: event.clientY }), last = session.value.points.at(-1)!;
    if (next.x === last.x && next.y === last.y) return;
    session.value = { ...session.value, points: [...session.value.points, next] }; setDraft(session.value);
  }
  function start(event: PointerEvent<HTMLElement>) {
    if (!mode || event.button !== 0 || blocked() || active.current || saving.current) return false;
    const target = event.target as Element;
    if (!target.closest('.react-flow__node, .react-flow__pane') || target.closest('button, input, textarea, [contenteditable=true], .react-flow__controls')) return false;
    const id = projectId(); if (!id) return false;
    event.preventDefault(); event.stopPropagation();
    const value = { projectId: id, penKind: mode, points: [point({ x: event.clientX, y: event.clientY })] };
    active.current = { value, pointerId: event.pointerId, element: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId); setDraft(value); return true;
  }
  function move(event: PointerEvent<HTMLElement>) {
    if (!active.current || active.current.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); append(event);
  }
  function finish(event: PointerEvent<HTMLElement>) {
    const session = active.current;
    if (!session || session.pointerId !== event.pointerId || session.value.projectId !== projectId()) return;
    event.preventDefault(); event.stopPropagation(); append(event);
    const value = active.current!.value; active.current = null;
    session.element.releasePointerCapture(event.pointerId); saving.current = true;
    const command: Command = { commandId: crypto.randomUUID(), projectId: value.projectId,
      type: "stroke.create", expected: null, payload: { id: crypto.randomUUID(), ...projection(value) } };
    void commit(command, () => { saving.current = false; setDraft(null); });
  }
  function cancel() {
    const session = active.current;
    if (!session) return;
    active.current = null; setDraft(null);
    if (session.element.hasPointerCapture(session.pointerId)) session.element.releasePointerCapture(session.pointerId);
  }
  return { mode, setMode, draft, drawing: !!draft, hasPending: () => !!active.current || saving.current,
    hasGesture: () => !!active.current, start, move, finish, cancel };
}

export function StrokePreview({ draft }: { draft: Draft | null }) {
  if (!draft) return null;
  const { content, pose } = projection(draft), first = content.path[0]!;
  return <svg role="img" aria-label="笔迹预览" width={pose.width} height={pose.height}
    style={{ position: "absolute", left: 0, top: 0, transform: `translate(${pose.x}px, ${pose.y}px)`, overflow: "visible", pointerEvents: "none" }}>
    {content.path.length === 1
      ? <circle cx={first.x} cy={first.y} r={content.width / 2} fill={content.color} opacity={content.opacity} />
      : <path d={content.path.map((p, index) => `${index ? "L" : "M"}${p.x} ${p.y}`).join(" ")}
        fill="none" stroke={content.color} strokeWidth={content.width} strokeLinecap="round" strokeLinejoin="round" opacity={content.opacity} />}
  </svg>;
}
