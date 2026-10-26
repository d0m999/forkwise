import { TITLE_COLORS } from "../../backend/src/mapping/presentation-values";
import { useRef, useState } from "react";
import type { Receipt } from "../../backend/src/mapping/contracts";
import {
  api,
  MappingError,
  type Card,
  type Command,
  type ProjectState,
} from "./api";

export type AppearanceInput = Pick<
  NonNullable<Card["appearance"]>,
  "titleColor" | "showPreview"
>;
type StyleCommand = Extract<Command, { type: "card.appearance" }>;
interface Input {
  projectId: string;
  cardId: string;
  value: AppearanceInput;
  generation: number;
  expected: string | null;
  submitted?: number;
  command?: StyleCommand;
}
const key = (projectId: string, cardId: string) =>
  JSON.stringify([projectId, cardId]);
const journal = "forkwise-appearance-recovery-v1";
const colors = Object.values(TITLE_COLORS);
function valid(input: Input) {
  if (
    !input ||
    typeof input.projectId !== "string" ||
    typeof input.cardId !== "string" ||
    !input.projectId ||
    !input.cardId ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !(input.expected === null || typeof input.expected === "string") ||
    !input.value ||
    !colors.includes(input.value.titleColor) ||
    typeof input.value.showPreview !== "boolean"
  )
    return false;
  if (input.command) {
    const c = input.command;
    if (
      c.type !== "card.appearance" ||
      c.projectId !== input.projectId ||
      c.payload.id !== input.cardId ||
      c.expected !== input.expected ||
      !c.commandId ||
      !colors.includes(c.payload.titleColor) ||
      typeof c.payload.showPreview !== "boolean" ||
      !Number.isSafeInteger(input.submitted) ||
      input.submitted! > input.generation ||
      input.submitted! < 1
    )
      return false;
  }
  return true;
}
// One queue owns immutable original requests and the newest local inputs. UI
// selection and authoritative readbacks can change without changing their target.
export function useAppearanceSave(
  current: () => ProjectState | null,
  refresh: (id: string) => Promise<ProjectState>,
  beforeSubmit: () => Promise<boolean>,
  acknowledged?: (command: StyleCommand, receipt: Receipt) => void,
) {
  const inputs = useRef(new Map<string, Input>()),
    initialized = useRef(false),
    damaged = useRef(false);
  const running = useRef<Promise<boolean> | null>(null);
  const [view, setView] = useState<Record<string, Input>>({});
  const [error, setError] = useState("");
  const conflictRef = useRef<{ input: Input; remote: Card } | null>(null);
  const resolving = useRef(false);
  const [conflict, setConflictView] = useState<{
    input: Input;
    remote: Card;
  } | null>(null);
  function setConflict(value: { input: Input; remote: Card } | null) {
    conflictRef.current = value;
    setConflictView(value);
  }
  if (!initialized.current) {
    initialized.current = true;
    try {
      const raw = localStorage.getItem(journal);
      if (raw) {
        const saved = JSON.parse(raw);
        if (
          !Array.isArray(saved) ||
          !saved.every(valid) ||
          new Set(saved.map((x: Input) => key(x.projectId, x.cardId))).size !==
            saved.length
        )
          throw new Error("损坏的外观恢复记录");
        for (const input of saved as Input[])
          inputs.current.set(key(input.projectId, input.cardId), input);
      }
    } catch {
      damaged.current = true;
    }
  }
  function publish() {
    setView(Object.fromEntries(inputs.current));
  }
  function persist() {
    publish();
    if (damaged.current) {
      setError("外观恢复记录损坏，原件已保留；请保留当前页面和本地输入");
      return false;
    }
    try {
      localStorage.setItem(
        journal,
        JSON.stringify([...inputs.current.values()]),
      );
      return true;
    } catch {
      setError("外观恢复区写入失败，本地输入仍在，请保留页面并重试");
      return false;
    }
  }
  async function flush(): Promise<boolean> {
    if (running.current) return running.current;
    if (conflictRef.current) return false;
    running.current = (async () => {
      while (inputs.current.size) {
        const [target, input] = inputs.current.entries().next().value!;
        try {
          if (!input.command) {
            if (!(await beforeSubmit()))
              throw new Error("请先确认外观调整之前的正文保存");
            input.command = {
              commandId: crypto.randomUUID(),
              projectId: input.projectId,
              type: "card.appearance",
              expected: input.expected,
              payload: {
                id: input.cardId,
                titleColor: input.value.titleColor,
                showPreview: input.value.showPreview,
              },
            };
            input.submitted = input.generation;
          }
          if (!persist()) return false;
          const original = input.command!;
          const receipt = await api.execute(original);
          acknowledged?.(original, receipt);
          const latest = await refresh(input.projectId);
          const active = inputs.current.get(target);
          if (active !== input) continue;
          if (input.generation === input.submitted)
            inputs.current.delete(target);
          else {
            // Only our own receipt advances the next intent's expected version.
            // A peer's newer projection must still conflict with that intent.
            if (!latest.cards.some((c) => c.id === input.cardId))
              throw new Error("这张卡片已删除，外观输入已保留");
            input.expected = receipt.versions?.appearance ?? input.expected;
            delete input.command;
            delete input.submitted;
          }
          if (!persist()) return false;
          setError("");
        } catch (e) {
          if (e instanceof MappingError && e.code === "VERSION_CONFLICT") {
            try {
              const latest = await refresh(input.projectId),
                remote = latest.cards.find((c) => c.id === input.cardId);
              if (remote) setConflict({ input, remote });
            } catch {
              /* Original request and local inputs remain durable. */
            }
          }
          setError(
            "外观保存未完成：" + (e instanceof Error ? e.message : "请重试"),
          );
          publish();
          return false;
        }
      }
      return true;
    })();
    const result = await running.current;
    running.current = null;
    return result;
  }
  function change(projectId: string, cardId: string, value: AppearanceInput) {
    const state = current(),
      card =
        state?.project.id === projectId
          ? state.cards.find((c) => c.id === cardId)
          : undefined;
    if (!card) return;
    const target = key(projectId, cardId),
      previous = inputs.current.get(target);
    if (previous) {
      previous.value = {
        titleColor: value.titleColor,
        showPreview: value.showPreview,
      };
      previous.generation++;
    } else
      inputs.current.set(target, {
        projectId,
        cardId,
        value: { titleColor: value.titleColor, showPreview: value.showPreview },
        generation: 1,
        expected: card.appearance?.versionId ?? null,
      });
    if (persist() && !error && !conflict) void flush();
  }
  async function reapply() {
    const selected = conflictRef.current;
    if (!selected || running.current || resolving.current) return;
    const { input, remote } = selected;
    resolving.current = true;
    try {
      const latest = await api.project(input.projectId),
        checked = latest.cards.find((c) => c.id === input.cardId);
      if (!checked) throw new Error("这张卡片已删除，外观输入已保留");
      if (checked.appearance?.versionId !== remote.appearance?.versionId) {
        setConflict({ input, remote: checked });
        throw new Error("外观再次更新，请比较后重新确认");
      }
      input.expected = checked.appearance?.versionId ?? null;
      delete input.command;
      delete input.submitted;
      setConflict(null);
      setError("");
      persist();
      // This explicit new intent uses the freshly checked version, never mutates
      // the original rejected request or reuses its commandId.
      await flush();
    } catch (e) {
      setError(
        "外观保存未完成：" + (e instanceof Error ? e.message : "请重试"),
      );
    } finally {
      resolving.current = false;
    }
  }
  const visible = Object.keys(view).length
    ? view
    : Object.fromEntries(inputs.current);
  return {
    value: (projectId: string, cardId: string) =>
      visible[key(projectId, cardId)]?.value,
    change,
    flush,
    reapply,
    conflict,
    error: error || (damaged.current ? "外观恢复记录损坏，原件已保留" : ""),
    pending: inputs.current.size > 0,
    hasPending: () => inputs.current.size > 0 || !!running.current,
  };
}
