import { useRef, useState } from "react";
import {
  api,
  MappingError,
  type Card,
  type Command,
  type ProjectState,
} from "./api";

type Position = { x: number; y: number };
type Pose = Card["item"]["pose"];
type GeometryCommand = Extract<Command, { type: "pose.move" | "pose.batch" }>;
export interface MoveOrder {
  beforeSubmit: () => Promise<boolean>;
  afterAttempt: () => void;
}
interface Pending {
  cards: Card[];
  command: GeometryCommand;
  order?: MoveOrder;
}

// One completed gesture owns one command. Body ACKs cannot clear its preview.
export function usePoseSave(
  refresh: (projectId: string) => Promise<ProjectState>,
) {
  const [positions, setPositions] = useState<Record<string, Pose>>({});
  const previewPoses = useRef<Record<string, Pose>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<Card["item"] | null>(null);
  const remote = useRef<Card[] | null>(null);
  const command = useRef<Pending | null>(null);
  const gesture = useRef<Pending | null>(null);
  const saving = useRef<Promise<boolean> | null>(null);
  const [dragging, setDragging] = useState(false);
  function clearPositions(cards: Card[]) {
    for (const card of cards) delete previewPoses.current[card.item.id];
    setPositions((previous) => {
      const next = { ...previous };
      for (const card of cards) delete next[card.item.id];
      return next;
    });
  }
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
        clearPositions(current.cards);
        setPending(false);
        setError("");
        setConflict(null);
        remote.current = null;
        return true;
      } catch (e) {
        if (e instanceof MappingError && e.code === "VERSION_CONFLICT") {
          try {
            const latest = await api.project(current.command.projectId);
            const cards = current.cards.map((c) =>
              latest.cards.find((x) => x.id === c.id),
            );
            if (cards.every((c): c is Card => !!c)) {
              remote.current = cards;
              setConflict(cards[0]!.item);
            }
          } catch {
            /* The original batch remains available for explicit retry. */
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
  function start(
    projectId: string,
    input: Card | Card[],
    order?: MoveOrder,
    fullGeometry = false,
  ) {
    if (command.current || gesture.current) return false;
    const cards = Array.isArray(input) ? input : [input];
    const card = cards[0];
    if (!card) return false;
    const common = { commandId: crypto.randomUUID(), projectId };
    gesture.current = {
      cards,
      ...(order ? { order } : {}),
      command:
        cards.length === 1 && !fullGeometry
          ? {
              ...common,
              type: "pose.move",
              expected: card.item.versionId,
              payload: {
                id: card.id,
                x: card.item.pose.x,
                y: card.item.pose.y,
              },
            }
          : {
              ...common,
              type: "pose.batch",
              expected: Object.fromEntries(
                cards.map((c) => [c.id, c.item.versionId]),
              ),
              payload: {
                poses: cards.map((c) => ({ id: c.id, ...c.item.pose })),
              },
            },
    };
    setDragging(true);
    return true;
  }
  function preview(itemId: string, position: Partial<Pose>) {
    const card = gesture.current?.cards.find((c) => c.item.id === itemId);
    if (card) {
      const pose = {
        ...card.item.pose,
        ...previewPoses.current[itemId],
        ...position,
      };
      previewPoses.current[itemId] = pose;
      setPositions((previous) => ({ ...previous, [itemId]: pose }));
    }
  }
  function finish(position?: Position) {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    setDragging(false);
    const anchor = current.cards[0]!;
    const final =
      position ?? previewPoses.current[anchor.item.id] ?? anchor.item.pose;
    const dx = final.x - anchor.item.pose.x,
      dy = final.y - anchor.item.pose.y;
    const poses = current.cards.map((c) => ({
      ...c.item.pose,
      ...previewPoses.current[c.item.id],
      ...(position ? { x: c.item.pose.x + dx, y: c.item.pose.y + dy } : {}),
    }));
    if (
      poses.every((p, i) =>
        Object.keys(p).every(
          (key) =>
            p[key as keyof Pose] ===
            current.cards[i]!.item.pose[key as keyof Pose],
        ),
      )
    ) {
      clearPositions(current.cards);
      current.order?.afterAttempt();
      return;
    }
    if (current.command.type === "pose.move")
      current.command.payload = {
        ...current.command.payload,
        x: final.x,
        y: final.y,
      };
    else
      current.command.payload.poses = current.cards.map((c, i) => ({
        id: c.id,
        ...poses[i]!,
      }));
    command.current = current;
    setPositions((previous) => ({
      ...previous,
      ...Object.fromEntries(
        current.cards.map((c, i) => [c.item.id, poses[i]!]),
      ),
    }));
    setPending(true);
    void flush();
  }
  function resolveConflict() {
    const current = command.current,
      cards = remote.current;
    if (!current || !cards || saving.current) return;
    current.command = {
      ...current.command,
      commandId: crypto.randomUUID(),
      expected:
        current.command.type === "pose.move"
          ? cards[0]!.item.versionId
          : Object.fromEntries(cards.map((c) => [c.id, c.item.versionId])),
    } as GeometryCommand;
    setConflict(null);
    setError("");
    void flush();
  }
  function cancel() {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    setDragging(false);
    clearPositions(current.cards);
    current.order?.afterAttempt();
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
    cancel,
    hasPending: () => !!(command.current || gesture.current || saving.current),
  };
}
