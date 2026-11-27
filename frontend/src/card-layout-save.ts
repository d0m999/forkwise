import { useRef, useState } from "react";
import type { Receipt } from '../../backend/src/mapping/contracts';
import {
  api,
  MappingError,
  type Card,
  type Command,
  type ProjectState,
} from "./api";
import { followerFields } from "./attachment-follow";
import { hasPreviewText } from "../../backend/src/mapping/body-text";

type LayoutCommand = Extract<Command, { type: "card.layout" }>;
type LayoutAcknowledgement = (command: LayoutCommand, receipt: Receipt) => void;
type LayoutResult = { key: string; command: LayoutCommand; receipt?: Receipt };
export function useCardLayoutSave(
  refresh: (id: string, beforePublish: () => void) => Promise<ProjectState>,
  current: () => ProjectState | null,
  acknowledged?: LayoutAcknowledgement,
) {
  const commands = useRef(new Map<string, LayoutCommand>());
  const confirming = useRef(new Map<string, LayoutResult>());
  const readback = useRef<{ projectId: string; completed: LayoutResult[] } | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function flush(): Promise<boolean> {
    if (running.current) return running.current;
    running.current = (async () => {
      while (commands.current.size || readback.current) {
        let failure: { error: unknown } | undefined;
        if (!readback.current) {
          const batch = [...commands.current];
          const projectId = batch[0]![1].projectId;
          const completed: LayoutResult[] = [];
          for (const [key, command] of batch) {
            const movesFollowers = !!command.followers?.length;
            if (command.projectId !== projectId || (movesFollowers && completed.length)) break;
            try {
              const receipt = await api.execute(command);
              const result = { key, command, receipt };
              confirming.current.set(key, result);
              completed.push(result);
              acknowledged?.(command, receipt);
            } catch (error) {
              if (!(error instanceof MappingError && error.code === "VERSION_CONFLICT")) {
                failure = { error };
                break;
              }
              // The old measurement was rejected. A new snapshot can change
              // its follower dependencies without changing the card fields.
              commands.current.delete(key);
              completed.push({ key, command });
              break;
            }
            if (movesFollowers) break;
          }
          if (completed.length) readback.current = { projectId, completed };
        }
        const batchToRead = readback.current;
        if (batchToRead) {
          try {
            await refresh(batchToRead.projectId, () => {
              // Keep newer measurements, including ones queued by background sync.
              for (const { key, command } of batchToRead.completed) {
                if (commands.current.get(key) === command) commands.current.delete(key);
              }
            });
            for (const { key } of batchToRead.completed) confirming.current.delete(key);
            readback.current = null;
          } catch (error) {
            // Retry the read for this known result before sending newer measurements.
            setError(error instanceof Error ? error.message : "卡面布局重新读取失败");
            return false;
          }
        }
        if (failure) {
          setError(failure.error instanceof Error ? failure.error.message : "卡面布局保存失败");
          return false;
        }
      }
      setPending(false);
      setError("");
      return true;
    })();
    try {
      return await running.current;
    } finally {
      running.current = null;
    }
  }
  function measure(card: Card, necessaryHeight: number) {
    const state = current(),
      latest = state?.cards.find((c) => c.id === card.id);
    if (
      !state ||
      !latest ||
      latest.versionId !== card.versionId ||
      latest.body.versionId !== card.body.versionId ||
      latest.item.versionId !== card.item.versionId ||
      latest.appearance?.versionId !== card.appearance?.versionId ||
      latest.cardTags?.versionId !== card.cardTags?.versionId
    )
      return;
    const policy = card.item.heightPolicy;
    const floor = policy
      ? (policy.manualHeight ??
        (hasPreviewText(card.body)
          ? (policy.previewFloor ?? 0)
          : 0))
      : card.item.pose.height;
    if (!policy && card.item.pose.height >= necessaryHeight) return;
    if (
      policy?.necessaryHeight === necessaryHeight &&
      card.item.pose.height === Math.max(floor, necessaryHeight)
    )
      return;
    const key = JSON.stringify([state.project.id, card.id]);
    const expected = {
      thought: card.versionId,
      body: card.body.versionId,
      pose: card.item.versionId,
      appearance: card.appearance?.versionId ?? null,
      cardTags: card.cardTags?.versionId ?? null,
    };
    const queued = commands.current.get(key);
    if (queued && (confirming.current.get(key)?.command !== queued || (
      queued.expected.thought === expected.thought &&
      queued.expected.body === expected.body &&
      queued.expected.pose === expected.pose &&
      queued.expected.appearance === expected.appearance &&
      queued.expected.cardTags === expected.cardTags &&
      queued.payload.necessaryHeight === necessaryHeight
    ))) return;
    const nextHeight = Math.max(necessaryHeight, floor);
    commands.current.set(key, {
      commandId: crypto.randomUUID(),
      projectId: state.project.id,
      type: "card.layout",
      ...followerFields(state, [{ itemId: card.item.id, dx: 0, dy: (nextHeight - card.item.pose.height) / 2 }], new Set()),
      expected,
      payload: { id: card.id, necessaryHeight },
    });
    setPending(true);
    if (!error) void flush();
  }
  return {
    measure,
    flush,
    pending,
    error,
    hasPending: () => commands.current.size > 0 || !!readback.current || !!running.current,
    acknowledgePending(acknowledge: LayoutAcknowledgement) {
      // A deletion entered after the POST can still have a pre-layout snapshot.
      for (const { command, receipt } of confirming.current.values()) {
        if (receipt) acknowledge(command, receipt);
      }
    },
  };
}
