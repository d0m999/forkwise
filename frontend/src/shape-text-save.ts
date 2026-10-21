import { useEffect, useRef, useState } from "react";
import { api, MappingError, type Command, type ProjectState } from "./api";
import type { CanvasShape } from "../../backend/src/mapping/shape-contracts";
import { ShapeTextRecovery, type ShapeTextRecord } from "./shape-text-recovery";
import { readOwnShapeRecoveryTarget } from "./shape-recovery-target";

export type ShapeTextSession = { projectId: string; value: CanvasShape; input: string };
type Edit = Extract<Command, { type: "shape.edit" }>;
type Create = Extract<Command, { type: "shape.create" }>;
export type ShapeTextConflict = { remote: CanvasShape | null };
export function useShapeTextSave(publish: (state: ProjectState) => void) {
  const [journal] = useState(() => new ShapeTextRecovery());
  const [session, setSession] = useState<ShapeTextSession | null>(null);
  const current = useRef<ShapeTextSession | null>(null), pending = useRef<Edit | null>(null);
  const confirmed = useRef<{ projectId: string; value: CanvasShape } | null>(null);
  const running = useRef<Promise<boolean> | null>(null), composing = useRef(false), needsRead = useRef(false);
  const [conflict, setConflict] = useState<ShapeTextConflict | null>(null);
  const conflictRef = useRef<ShapeTextConflict | null>(null);
  const recovery = useRef<Create | null>(null), [recovering, setRecovering] = useState(false);
  const copy = useRef<Pick<CanvasShape, "versionId" | "content"> | null>(null), copyPending = useRef<Edit | null>(null);
  const [error, setError] = useState(""), [working, setWorking] = useState(false);
  function showConflict(value: ShapeTextConflict | null) { conflictRef.current = value; setConflict(value); }
  function persist() {
    if (!current.current) return;
    journal.write({ schema: 1, session: current.current, pending: pending.current, confirmed: confirmed.current,
      needsRead: needsRead.current, conflict: conflictRef.current, recovery: recovery.current,
      copy: copy.current, copyPending: copyPending.current });
  }
  function update(value: ShapeTextSession | null) { current.current = value; setSession(value); }
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (current.current && (pending.current || needsRead.current || recovery.current ||
        current.current.input !== current.current.value.content.shortText)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);
  function begin(projectId: string, value: CanvasShape) {
    if (current.current || pending.current) return;
    update({ projectId, value: structuredClone(value), input: value.content.shortText });
    confirmed.current = { projectId, value: structuredClone(value) };
    setError("");
  }
  function change(input: string) {
    if (current.current && !running.current) {
      update({ ...current.current, input });
      try { persist(); } catch { setError("形状文字草稿无法写入本机恢复记录，请保留输入并重试"); }
    }
  }
  function restore(record: { key: string; value: ShapeTextRecord }) {
    if (current.current || pending.current || running.current) return false;
    journal.write(record.value); // New owner must be durable before retiring the selected old record.
    journal.remove(record.key);
    const value = structuredClone(record.value);
    pending.current = value.pending; confirmed.current = value.confirmed; needsRead.current = value.needsRead;
    recovery.current = value.recovery; copy.current = value.copy; copyPending.current = value.copyPending;
    showConflict(value.conflict); setRecovering(!!value.recovery); update(value.session);
    setError("较新形状文字输入已恢复，原请求仍待确认"); return true;
  }
  async function finish(): Promise<boolean> {
    if (composing.current) return false;
    if (running.current) return running.current;
    if (conflict) return false;
    if (!current.current) return true;
    setWorking(true);
    running.current = (async () => {
      try {
        for (;;) {
          const value = current.current;
          if (!value || composing.current) return false;
          if (!pending.current && value.input === value.value.content.shortText) {
            if (needsRead.current) {
              const latest = await api.project(value.projectId);
              publish(latest);
              needsRead.current = false;
              persist();
            }
            journal.remove();
            update(null); setError(""); return true;
          }
          const command = pending.current ?? {
            commandId: crypto.randomUUID(), projectId: value.projectId, type: "shape.edit" as const,
            expected: value.value.versionId,
            payload: { id: value.value.id, content: { ...value.value.content, shortText: value.input } },
          };
          pending.current = command; persist();
          const receipt = await api.execute(command);
          // A no-op confirms our expected version. A write must return its own
          // transaction's immutable version, never a subsequent project read.
          const version = receipt.shapeVersions?.shape ?? (receipt.changedIds.length === 0 ? command.expected : undefined);
          if (!version || receipt.commandId !== command.commandId || receipt.projectId !== command.projectId)
            throw new Error("形状保存回执不完整，原请求及输入仍保留");
          const newer = current.current;
          if (!newer || newer.projectId !== command.projectId || newer.value.id !== command.payload.id || newer.value.item.id !== value.value.item.id)
            throw new Error("形状输入目标已变化，原请求仍保留");
          const saved = { ...newer.value, versionId: version, content: command.payload.content };
          confirmed.current = { projectId: command.projectId, value: saved };
          update({ ...newer, value: saved });
          pending.current = null;
          needsRead.current = true;
          persist();
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "形状文字保存未确认");
        if (failure instanceof MappingError && ["VERSION_CONFLICT", "NOT_FOUND"].includes(failure.code)) {
          const value = current.current;
          if (value) {
            let latest: ProjectState;
            try {
              latest = await api.project(value.projectId);
            } catch { setError("无法读取对方版本，原请求及完整输入仍保留，请重试"); return false; }
            showConflict({ remote: latest.shapes?.find(shape => shape.id === value.value.id) ?? null });
            try { persist(); } catch { setError("冲突恢复记录无法写入，当前完整输入仍保留"); }
          }
        }
        return false;
      }
    })();
    const result = await running.current;
    running.current = null;
    setWorking(false);
    return result;
  }
  async function recover(): Promise<boolean> {
    if (composing.current || !conflict || !current.current) return false;
    if (running.current) return running.current;
    setWorking(true); setError("");
    running.current = (async () => {
      let confirmedPose: string | undefined;
      let creationReceipt: Awaited<ReturnType<typeof api.execute>> | undefined;
      try {
        const value = current.current!;
        const command: Create = recovery.current ?? {
          commandId: crypto.randomUUID(), projectId: value.projectId, type: "shape.create", expected: null,
          payload: { id: crypto.randomUUID(), content: { ...value.value.content, shortText: value.input },
            pose: { ...value.value.item.pose } },
        };
        // An unknown creation result retries these exact identities and payload.
        // Later input remains separate and only edits the acknowledged copy.
        recovery.current = command; setRecovering(true); persist();
        const receipt = await api.execute(command);
        if (receipt.commandId !== command.commandId || receipt.projectId !== command.projectId || !receipt.shapeVersions?.shape)
          throw new Error("形状恢复回执不完整，原请求及输入仍保留");
        confirmedPose = receipt.shapeVersions.pose;
        creationReceipt = receipt;
        copy.current ??= { versionId: receipt.shapeVersions.shape, content: command.payload.content };
        persist();
        while (copyPending.current || current.current!.input !== copy.current.content.shortText) {
          const edit: Edit = copyPending.current ?? {
            commandId: crypto.randomUUID(), projectId: command.projectId, type: "shape.edit", expected: copy.current.versionId,
            payload: { id: command.payload.id, content: { ...command.payload.content, shortText: current.current!.input } },
          };
          copyPending.current = edit; persist();
          const ack = await api.execute(edit);
          const version = ack.shapeVersions?.shape ?? (ack.changedIds.length === 0 ? edit.expected : undefined);
          if (!version || ack.commandId !== edit.commandId || ack.projectId !== edit.projectId)
            throw new Error("副本短文回执不完整，原请求及后续输入仍保留");
          copy.current = { versionId: version, content: edit.payload.content }; copyPending.current = null;
          persist();
        }
        publish(await api.project(command.projectId));
        journal.remove();
        pending.current = null; needsRead.current = false; recovery.current = null; copy.current = null;
        showConflict(null); setRecovering(false); update(null); setError(""); return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "形状恢复尚未确认");
        if (failure instanceof MappingError && ["VERSION_CONFLICT", "NOT_FOUND"].includes(failure.code) &&
          current.current && recovery.current && copy.current && copyPending.current && confirmedPose && creationReceipt) {
          const session = current.current, create = recovery.current, ownCopy = copy.current;
          try {
            const latest = await api.project(session.projectId);
            const remote = latest.shapes?.find(shape => shape.id === create.payload.id) ?? null;
            // The read supplies stable identity and comparison only. This
            // proposal keeps its own confirmed content/Pose versions and Pose.
            const base: CanvasShape = remote ? { ...remote, versionId: ownCopy.versionId, content: ownCopy.content,
              item: { ...remote.item, versionId: confirmedPose, pose: { ...create.payload.pose } } }
              : await readOwnShapeRecoveryTarget(create, creationReceipt, ownCopy);
            const nextSession = { projectId: session.projectId, value: base, input: session.input };
            const next: ShapeTextRecord = { schema: 1, session: nextSession,
              confirmed: { projectId: session.projectId, value: base }, pending: null, needsRead: false,
              conflict: { remote }, recovery: null, copy: null, copyPending: null };
            // Retire the deterministically rejected edit only after the full
            // new target is durable; unknown requests still retry unchanged.
            journal.write(next);
            pending.current = null; confirmed.current = next.confirmed; needsRead.current = false;
            recovery.current = null; copy.current = null; copyPending.current = null;
            showConflict(next.conflict); setRecovering(false); update(nextSession);
            setError("恢复副本已更新，请比较双方后明确恢复新形状");
          } catch (readOrJournalFailure) {
            setError(readOrJournalFailure instanceof Error ? readOrJournalFailure.message : "副本比较无法保全，原请求及全文仍保留");
          }
        }
        return false;
      }
    })();
    const result = await running.current;
    running.current = null; setWorking(false); return result;
  }
  return {
    session, begin, change, finish, recover, conflict, recovering, error, locked: working,
    journal, restore, currentSession: () => current.current,
    confirmed: () => confirmed.current,
    compose: (active: boolean) => { composing.current = active; },
    hasPending: () => needsRead.current || !!pending.current || !!current.current && current.current.input !== current.current.value.content.shortText,
    status: error ? "形状文字保存未完成" : working ? "形状文字正在保存…" :
      session && session.input !== session.value.content.shortText ? "形状文字等待保存" : "",
  };
}
