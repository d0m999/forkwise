import { useRef, useState } from "react";
import {
  api,
  MappingError,
  type Card,
  type Command,
  type ProjectState,
} from "./api";

type LayoutCommand = Extract<Command, { type: "card.layout" }>;
export function useCardLayoutSave(
  refresh: (id: string) => Promise<ProjectState>,
  current: () => ProjectState | null,
) {
  const commands = useRef(new Map<string, LayoutCommand>());
  const running = useRef<Promise<boolean> | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function flush(): Promise<boolean> {
    if (running.current) return running.current;
    running.current = (async () => {
      while (commands.current.size) {
        const [key, command] = commands.current.entries().next().value!;
        try {
          await api.execute(command);
          // Release the acknowledged measurement before publishing readback.
          // Its new title/body may need another measurement during that render.
          commands.current.delete(key);
          try {
            await refresh(command.projectId);
          } catch (e) {
            if (!commands.current.has(key)) commands.current.set(key, command);
            throw e;
          }
        } catch (e) {
          if (e instanceof MappingError && e.code === "VERSION_CONFLICT") {
            // A measurement is derived from the captured facts; discard only
            // that rejected measurement and remeasure the complete new snapshot.
            commands.current.delete(key);
            try {
              await refresh(command.projectId);
            } catch (readError) {
              if (!commands.current.has(key))
                commands.current.set(key, command);
              setError(
                readError instanceof Error
                  ? readError.message
                  : "卡面布局重新读取失败",
              );
              return false;
            }
          } else {
            setError(e instanceof Error ? e.message : "卡面布局保存失败");
            return false;
          }
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
      latest.appearance?.versionId !== card.appearance?.versionId
    )
      return;
    const policy = card.item.heightPolicy;
    const floor = policy
      ? (policy.manualHeight ??
        (card.body.blocks.some((b) => b.text.length > 0)
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
    if (commands.current.has(key)) return;
    commands.current.set(key, {
      commandId: crypto.randomUUID(),
      projectId: state.project.id,
      type: "card.layout",
      expected: {
        thought: card.versionId,
        body: card.body.versionId,
        pose: card.item.versionId,
        appearance: card.appearance?.versionId ?? null,
      },
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
    hasPending: () => commands.current.size > 0 || !!running.current,
  };
}
