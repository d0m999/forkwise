import { useEffect, useRef, useState } from "react";
import { api, MappingError, type ProjectState } from "./api";
import type {
  CanvasText,
  TextCommand,
  TextContent,
} from "../../backend/src/mapping/text-contracts";
import { TextRecovery } from "./text-recovery";
import { captureMemberDeletion } from "./canvas-group-commands";
export type TextSession = {
  projectId: string;
  value: CanvasText;
  content: TextContent;
  group: string;
  generation: number;
  confirmed: number;
};
export type TextSubmitted = { session: TextSession; command: TextCommand };
export function useTextSave(
  publish: (state: ProjectState) => void,
  conflict: (session: TextSession, command: TextCommand) => Promise<void>,
  project: () => ProjectState | null,
  acknowledged?: (command: TextCommand, receipt: Awaited<ReturnType<typeof api.execute>>) => void,
) {
  const [session, setSession] = useState<TextSession | null>(null);
  const current = useRef<TextSession | null>(null),
    pending = useRef<TextSubmitted | null>(null);
  const deleteIntent = useRef<({ session: TextSession } & NonNullable<ReturnType<typeof captureMemberDeletion>>) | null>(null);
  const closeAttempt = useRef<TextSession | null>(null);
  const [journal] = useState(() => new TextRecovery());
  const [recoveries, setRecoveries] = useState(() => journal.list());
  const saving = useRef<Promise<boolean> | null>(null),
    composing = useRef(false);
  const deferredClose = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    maxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [error, setError] = useState(""),
    [working, setWorking] = useState(false);
  function persist(): boolean {
    try {
      journal.write(current.current, pending.current);
      return true;
    } catch {
      setError("文字草稿无法写入本机恢复记录，请保留当前输入并重试");
      return false;
    }
  }
  function update(value: TextSession | null) {
    if (!value) { deleteIntent.current = null; closeAttempt.current = null; }
    current.current = value;
    setSession(value);
    persist();
  }
  function clearTimers() {
    clearTimeout(timer.current);
    clearTimeout(maxTimer.current);
    maxTimer.current = undefined;
  }
  function schedule() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flush();
    }, 400);
    maxTimer.current ??= setTimeout(() => {
      void flush();
    }, 2000);
  }
  function sameClose(value: TextSession | null, captured: TextSession) {
    return !!value && value.projectId === captured.projectId && value.value.id === captured.value.id &&
      value.value.item.id === captured.value.item.id && value.generation === captured.generation;
  }
  function prepareClose(): boolean {
    const value = current.current;
    if (!value || composing.current) return true;
    if (closeAttempt.current && sameClose(value, closeAttempt.current)) return true;
    closeAttempt.current = null; deleteIntent.current = null;
    if (pending.current?.command.type === 'text.delete' || value.content.runs.some(run => run.text.trim())) {
      closeAttempt.current = value; return true;
    }
    const snapshot = project(), facts = snapshot && captureMemberDeletion(snapshot, value.value, value.projectId);
    if (!facts) {
      setError('请先确认原文字和完整连线投影，再明确结束编辑'); return false;
    }
    deleteIntent.current = { session: structuredClone(value), ...facts }; closeAttempt.current = value; return true;
  }
  async function flush(close = false, closing: TextSession | null = null): Promise<boolean> {
    clearTimers();
    if (composing.current) {
      if (close) deferredClose.current = true;
      return false;
    }
    if (close && !current.current) return saving.current ? await saving.current : true;
    if (close && !closing) {
      if (!closeAttempt.current && !prepareClose()) return false;
      closing = closeAttempt.current;
    }
    // Waiting for an ACK cannot turn an older finish into a later draft's delete.
    if (close && closing && (closeAttempt.current !== closing || !sameClose(current.current, closing))) {
      if (closeAttempt.current === closing) { closeAttempt.current = null; deleteIntent.current = null; }
      if (current.current?.projectId === closing.projectId && current.current.value.id === closing.value.id)
        setError('文字已变化，请再次明确结束编辑');
      return false;
    }
    if (saving.current) {
      if (!(await saving.current)) return false;
      return flush(close, closing);
    }
    const value = current.current;
    if (!value) return true;
    const empty = !value.content.runs
      .map((run) => run.text)
      .join("")
      .trim();
    if (
      !pending.current &&
      ((!close && empty) || (value.generation === value.confirmed && !empty))
    ) {
      if (close) update(null);
      return true;
    }
    const captured = empty ? (deleteIntent.current?.session ?? value) : value;
    const submitted = pending.current ?? {
      session: captured,
      command: empty
        ? {
            commandId: crypto.randomUUID(),
            projectId: captured.projectId,
            type: "text.delete",
            expected: {
              text: captured.value.versionId,
              pose: captured.value.item.versionId,
              connectors: deleteIntent.current!.connectors,
              membership: deleteIntent.current!.membership,
            },
            editGroup: captured.group,
            payload: { id: captured.value.id },
          }
        : {
            commandId: crypto.randomUUID(),
            projectId: value.projectId,
            type: "text.edit",
            expected: value.value.versionId,
            editGroup: value.group,
            payload: { id: value.value.id, content: value.content },
          },
    };
    pending.current = submitted;
    if (!persist()) return false;
    setWorking(true);
    saving.current = (async () => {
      try {
        const receipt = await api.execute(submitted.command);
        acknowledged?.(submitted.command, receipt);
        const intent = deleteIntent.current;
        // Only this original save may advance the captured text version. The
        // incident set stays fixed even if the following read includes peers.
        if (submitted.command.type === 'text.edit' && intent &&
          intent.session.projectId === submitted.session.projectId &&
          intent.session.value.id === submitted.session.value.id &&
          intent.session.value.item.id === submitted.session.value.item.id &&
          intent.session.value.versionId === submitted.command.expected &&
          receipt.commandId === submitted.command.commandId && receipt.projectId === submitted.command.projectId && receipt.textVersions?.text) {
          intent.session = { ...intent.session, value: { ...intent.session.value,
            content: submitted.session.content, versionId: receipt.textVersions.text } };
        }
        const latest = await api.project(submitted.session.projectId);
        publish(latest);
        const newer = current.current;
        if (
          newer?.value.id === submitted.session.value.id &&
          newer.projectId === submitted.session.projectId
        ) {
          if (submitted.command.type === "text.delete") update(null);
          else
            update({
              ...newer,
              confirmed: submitted.session.generation,
              value: {
                ...newer.value,
                content: submitted.session.content,
                versionId:
                  receipt.textVersions?.text ??
                  submitted.session.value.versionId,
              },
            });
        }
        pending.current = null;
        persist();
        setError("");
        return true;
      } catch (failure) {
        if (
          failure instanceof MappingError &&
          (failure.code === "VERSION_CONFLICT" || failure.code === "NOT_FOUND")
        ) {
          try {
            await conflict(
              current.current ?? submitted.session,
              submitted.command,
            );
            pending.current = null;
            update(null);
            setError("");
            return false;
          } catch {
            /* Retain the original journal if conflict adoption fails. */
          }
        }
        setError(failure instanceof Error ? failure.message : "文字保存未完成");
        return false;
      }
    })();
    const result = await saving.current;
    saving.current = null;
    setWorking(false);
    if (!result) return false;
    if (close) return flush(true, closing);
    if (
      current.current &&
      current.current.generation > current.current.confirmed
    )
      schedule();
    return true;
  }
  function begin(value: Omit<TextSession, "generation" | "confirmed">) {
    deleteIntent.current = null; closeAttempt.current = null;
    update({ ...value, generation: 0, confirmed: 0 });
  }
  function change(content: TextContent) {
    if (!current.current || pending.current?.command.type === "text.delete")
      return;
    update({
      ...current.current,
      content,
      generation: current.current.generation + 1,
    });
    schedule();
  }
  function compose(active: boolean, content?: TextContent) {
    if (content) change(content);
    composing.current = active;
    if (!active) {
      if (deferredClose.current) {
        deferredClose.current = false;
        void flush(true);
      } else schedule();
    }
  }
  async function recover(key: string) {
    const record = journal.list().find((record) => record.key === key);
    if (!record || current.current) return;
    pending.current = record.value.pending;
    update(record.value.session);
    // Retire only the selected old journal after its exact content and request
    // have been durably adopted by this editor's independently owned journal.
    try {
      journal.write(current.current, pending.current);
      journal.remove(key);
      setRecoveries(journal.list());
    } catch {
      setError("无法接管恢复记录，请保留原草稿");
      return;
    }
    void flush();
  }
  useEffect(() => () => clearTimers(), []);
  const dirty = !!session && session.generation > session.confirmed;
  return {
    session,
    ending: pending.current?.command.type === "text.delete",
    current,
    begin,
    change,
    compose,
    prepareClose,
    flush,
    error,
    recoveries,
    recover,
    isSaving: () => !!saving.current,
    hasPending: () =>
      !!pending.current ||
      (!!current.current &&
        (current.current.generation > current.current.confirmed ||
          !current.current.content.runs.some((run) => run.text.trim()))),
    status: error
      ? "文字保存未完成"
      : working
        ? "文字正在保存…"
        : dirty
          ? "文字等待保存…"
          : recoveries.length
            ? "有待恢复的独立文字草稿"
            : "",
  };
}
