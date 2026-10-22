import { useRef, useState } from "react";
import { api, MappingError, type Command, type ProjectState } from "./api";
import type { CanvasText, TextContent } from "../../backend/src/mapping/text-contracts";
export type TextOperationTarget = {
  projectId: string;
  id: string;
  discard?: () => void;
};
type Operation = {
  sequence: number;
  target?: TextOperationTarget;
  prepare: () => Promise<Command | null>;
  command?: Command;
  done?: (state: ProjectState, receipt: Awaited<ReturnType<typeof api.execute>>) => void;
};
type ConfirmedContent = { version: string; content: string; pose?: { version: string; value: CanvasText["item"]["pose"] } };
// A successful prepare read can determine a conflict before any mutation was
// sent. Keep that fact separate from an uncertain request or failed read.
export class TextPrepareConflict extends Error {
  constructor(
    readonly command: Command,
    readonly local: CanvasText,
    readonly latest: ProjectState,
  ) {
    super("文字操作与已保存状态冲突");
  }
}
// All completed object gestures share one ordered boundary. A request survives
// a lost response unchanged; later gestures cannot overtake its confirmation.
export function useTextOperations(
  publish: (state: ProjectState) => void,
  conflict: (command: Command, preparation?: TextPrepareConflict) => Promise<boolean | { through: number }>,
) {
  const queue = useRef<Operation[]>([]),
    saving = useRef<Promise<boolean> | null>(null);
  const sequence = useRef(0);
  const layoutVersions = useRef(new Map<string, string>());
  const contentVersions = useRef(new Map<string, ConfirmedContent>());
  const layoutKey = (projectId: string, id: string, text: string, pose: string) =>
    JSON.stringify([projectId, id, text, pose]);
  function poseVersion(projectId: string, id: string, text: string, pose: string) {
    let version = pose;
    let next = layoutVersions.current.get(layoutKey(projectId, id, text, version));
    while (next && next !== version) {
      version = next;
      next = layoutVersions.current.get(layoutKey(projectId, id, text, version));
    }
    return version;
  }
  function confirmedContent(projectId: string, id: string, text: string, original: TextContent) {
    let version = text, content = original, pose: ConfirmedContent["pose"];
    let next = contentVersions.current.get(layoutKey(projectId, id, version, ""));
    while (next && next.version !== version) {
      version = next.version; content = JSON.parse(next.content) as TextContent; pose = next.pose ?? pose;
      next = contentVersions.current.get(layoutKey(projectId, id, version, ""));
    }
    return { version, content, ...(pose ? { pose } : {}) };
  }
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [scope, setScope] = useState<'文字' | '画布'>('文字');
  async function flush(): Promise<boolean> {
    if (saving.current) return saving.current;
    saving.current = (async () => {
      try {
        while (queue.current.length) {
          const operation = queue.current[0]!;
          const command = operation.command ?? (await operation.prepare());
          if (command) {
            operation.command = command;
            setScope(command.type === 'canvas.move' ? '画布' : '文字');
            const receipt = await api.execute(command);
            const value = await api.project(command.projectId);
            if (command.type === "text.layout" && receipt.textVersions?.pose) {
              layoutVersions.current.set(
                layoutKey(command.projectId, command.payload.id, command.expected.text, command.expected.pose),
                receipt.textVersions.pose,
              );
            }
            if ((command.type === "text.edit" || command.type === "text.transform") && receipt.textVersions?.text) {
              contentVersions.current.set(
                layoutKey(command.projectId, command.payload.id, command.type === "text.edit" ? command.expected : command.expected.text, ""),
                { version: receipt.textVersions.text, content: JSON.stringify(command.payload.content),
                  ...(command.type === "text.transform" && receipt.textVersions.pose ? { pose: { version: receipt.textVersions.pose, value: command.payload.pose } } : {}),
                },
              );
            }
            publish(value);
            operation.done?.(value, receipt);
          }
          queue.current.shift();
        }
        setPending(false);
        setError("");
        return true;
      } catch (failure) {
        const operation = queue.current[0];
        const preparation = failure instanceof TextPrepareConflict ? failure : undefined;
        const rejected = preparation?.command ?? (
          failure instanceof MappingError &&
          (failure.code === "VERSION_CONFLICT" || failure.code === "NOT_FOUND")
            ? operation?.command : undefined
        );
        if (rejected && operation) {
          try {
            const adoption = await conflict(rejected, preparation);
            if (adoption) {
              const target = operation.target;
              const retired = target
                ? queue.current.filter(
                    (value) =>
                      value.target?.projectId === target.projectId &&
                      value.target.id === target.id &&
                      (adoption === true || value.sequence <= adoption.through),
                  )
                : [operation];
              queue.current = queue.current.filter(
                (value) => !retired.includes(value),
              );
              for (const value of retired) value.target?.discard?.();
              setPending(!!queue.current.length);
              setError("");
              return false;
            }
          } catch (adoption) {
            setError(
              adoption instanceof Error
                ? adoption.message
                : "无法保留文字冲突草稿",
            );
            return false;
          }
        }
        setError(
          failure instanceof Error ? failure.message : "文字操作尚未确认",
        );
        return false;
      }
    })();
    const result = await saving.current;
    saving.current = null;
    return result;
  }
  function enqueue(
    prepare: Operation["prepare"],
    done?: Operation["done"],
    target?: TextOperationTarget,
  ) {
    queue.current.push({
      sequence: ++sequence.current,
      prepare,
      ...(done ? { done } : {}),
      ...(target ? { target } : {}),
    });
    setPending(true);
    void flush();
  }
  return {
    scope,
    enqueue,
    flush,
    pending,
    error,
    hasPending: () => !!queue.current.length,
    checkpoint: () => sequence.current,
    confirmedContent,
    confirmedText: (projectId: string, origin: CanvasText): CanvasText => {
      const next = confirmedContent(projectId, origin.id, origin.versionId, origin.content);
      const value = { ...origin, versionId: next.version, content: next.content,
        item: next.pose ? { ...origin.item, versionId: next.pose.version, pose: next.pose.value } : origin.item };
      return { ...value, item: { ...value.item, versionId: poseVersion(projectId, value.id, value.versionId, value.item.versionId) } };
    },
    textVersion: (projectId: string, id: string, text: string, displayed: TextContent) => {
      let version = text, matched = text;
      const content = JSON.stringify(displayed);
      let next = contentVersions.current.get(layoutKey(projectId, id, version, ""));
      while (next && next.version !== version) {
        version = next.version;
        if (next.content === content) matched = version;
        next = contentVersions.current.get(layoutKey(projectId, id, version, ""));
      }
      return matched;
    },
    // Derived measurements preserve x/y and content. Only our original
    // expected -> ACK pair may advance a gesture that used that same text.
    poseVersion,
  };
}
