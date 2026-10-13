import { useRef, useState } from "react";
import {
  api,
  MappingError,
  type Card,
  type Command,
  type ProjectState,
} from "./api";

type Position = { x: number; y: number };
type Move = Extract<Command, { type: "pose.move" }>;
export interface MoveOrder {
  beforeSubmit: () => Promise<boolean>;
  afterAttempt: () => void;
}
interface Pending {
  itemId: string;
  command: Move;
  order?: MoveOrder;
}

// Pose has its own in-flight command. Body ACKs cannot own or clear this draft.
export function usePoseSave(
  refresh: (projectId: string) => Promise<ProjectState>,
) {
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<Card["item"] | null>(null);
  const command = useRef<Pending | null>(null);
  const gesture = useRef<Pending | null>(null);
  const saving = useRef<Promise<boolean> | null>(null);
  const [dragging, setDragging] = useState(false);
  const clearPosition = (id: string) =>
    setPositions((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  async function flush(): Promise<boolean> {
    if (gesture.current) return false;
    if (saving.current) return saving.current;
    const current = command.current;
    if (!current) return true;
    saving.current = (async () => {
      try {
        if (current.order && !(await current.order.beforeSubmit()))
          throw new Error("请先确认此移动之前的正文保存，再重试布局保存");
        try {
          await api.execute(current.command);
        } finally {
          current.order?.afterAttempt();
        }
        await refresh(current.command.projectId);
        command.current = null;
        clearPosition(current.itemId);
        setPending(false);
        setError("");
        setConflict(null);
        return true;
      } catch (e) {
        if (e instanceof MappingError && e.code === "VERSION_CONFLICT") {
          try {
            const latest = await api.project(current.command.projectId);
            setConflict(
              latest.cards.find((c) => c.id === current.command.payload.id)
                ?.item ?? null,
            );
          } catch {
            /* Preserve the attempted move; retry can reload the conflict. */
          }
        }
        setError(e instanceof Error ? e.message : "布局保存失败，请重试");
        return false;
      }
    })();
    const result = await saving.current;
    saving.current = null;
    return result;
  }
  function start(projectId: string, card: Card, order?: MoveOrder) {
    if (command.current || gesture.current) return false;
    gesture.current = {
      itemId: card.item.id,
      ...(order ? { order } : {}),
      command: {
        commandId: crypto.randomUUID(),
        projectId,
        type: "pose.move",
        expected: card.item.versionId,
        payload: { id: card.id, x: card.item.pose.x, y: card.item.pose.y },
      },
    };
    setDragging(true);
    return true;
  }
  function preview(itemId: string, position: Position) {
    if (gesture.current?.itemId === itemId)
      setPositions((previous) => ({ ...previous, [itemId]: position }));
  }
  function finish(position: Position) {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    setDragging(false);
    current.command.payload = { ...current.command.payload, ...position };
    command.current = current;
    setPositions((previous) => ({ ...previous, [current.itemId]: position }));
    setPending(true);
    void flush();
  }
  function resolveConflict() {
    if (!conflict || !command.current || saving.current) return;
    command.current.command = {
      ...command.current.command,
      commandId: crypto.randomUUID(),
      expected: conflict.versionId,
    };
    setConflict(null);
    setError("");
    void flush();
  }
  return {
    positions,
    pending,
    dragging,
    error,
    conflict,
    resolveConflict,
    flush,
    start,
    preview,
    finish,
    hasPending: () => !!(command.current || gesture.current || saving.current),
  };
}
