import { useRef, useState } from "react";
import { api, type ProjectState } from "./api";
import {
  TextCommands,
  type TextCommand,
} from "../../backend/src/mapping/text-contracts";
type Create = Extract<TextCommand, { type: "text.create" }>;
const prefix = "forkwise:text-create-recovery:v1:";
export function useTextCreate(
  created: (state: ProjectState, command: Create) => void,
) {
  const [key] = useState(() => prefix + crypto.randomUUID());
  const pending = useRef<Create | null>(null),
    running = useRef<Promise<boolean> | null>(null);
  const [error, setError] = useState(""),
    [working, setWorking] = useState(false);
  function list() {
    const records: { key: string; command: Create }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)!;
      if (!name.startsWith(prefix) || name === key) continue;
      try {
        const value = JSON.parse(localStorage.getItem(name)!);
        const parsed = TextCommands.safeParse(value.command);
        if (
          value.schema === 1 &&
          parsed.success &&
          parsed.data.type === "text.create" &&
          parsed.data.editGroup
        )
          records.push({ key: name, command: parsed.data });
      } catch {
        /* Unknown records remain untouched. */
      }
    }
    return records;
  }
  const [recoveries, setRecoveries] = useState(list);
  function persist() {
    if (pending.current)
      localStorage.setItem(
        key,
        JSON.stringify({ schema: 1, command: pending.current }),
      );
    else localStorage.removeItem(key);
  }
  async function flush(): Promise<boolean> {
    if (running.current) return running.current;
    if (!pending.current) return true;
    const command = pending.current;
    setWorking(true);
    running.current = (async () => {
      try {
        persist(); // Record identity and the exact request before any mutation.
        await api.execute(command);
        const latest = await api.project(command.projectId);
        created(latest, command);
        pending.current = null;
        persist();
        setError("");
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "文字创建未确认");
        return false;
      }
    })();
    const result = await running.current;
    running.current = null;
    setWorking(false);
    return result;
  }
  function send(command: Create) {
    pending.current ??= command;
    return flush();
  }
  async function recover(name: string) {
    if (pending.current) return;
    const record = list().find((record) => record.key === name);
    if (!record) return;
    pending.current = record.command;
    try {
      persist();
      localStorage.removeItem(name);
      setRecoveries(list());
    } catch {
      setError("无法接管文字创建恢复记录，请保留原记录");
      return;
    }
    await flush();
  }
  return {
    send,
    flush,
    recover,
    recoveries,
    error,
    hasPending: () => !!pending.current,
    status: error
      ? "文字保存未完成"
      : working
        ? "文字正在保存…"
        : recoveries.length
          ? "有待恢复的独立文字草稿"
          : "",
  };
}
