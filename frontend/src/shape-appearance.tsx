import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, MappingError, type Command, type ProjectState } from "./api";
import { ShapeAppearanceRecovery, type ShapeAppearanceRecord, type ShapeAppearanceConflict, type ShapeAppearanceFields, type ShapeAppearanceCopy } from "./shape-appearance-recovery";
import type { CanvasShape } from "../../backend/src/mapping/shape-contracts";
import { readOwnShapeRecoveryTarget } from "./shape-recovery-target";

export type ShapeAppearanceBinding = { projectId: string; value: CanvasShape; trigger?: HTMLButtonElement; journal?: ShapeAppearanceRecovery; record?: ShapeAppearanceRecord };
type Edit = Extract<Command, { type: "shape.edit" }>;
type Create = Extract<Command, { type: "shape.create" }>;
type Fields = ShapeAppearanceFields;
export function ShapeAppearance({ binding, publish, close }: {
  binding: ShapeAppearanceBinding; publish: (state: ProjectState) => void; close: () => void;
}) {
  const restored = binding.record;
  const [journal] = useState(() => binding.journal ?? new ShapeAppearanceRecovery());
  const dialog = useRef<HTMLDialogElement>(null), value = useRef(restored?.value ?? binding.value);
  const original = useRef(restored?.original ?? binding.value);
  const initial = restored?.fields ?? { fill: binding.value.content.fill ?? "", stroke: binding.value.content.stroke ?? "",
    strokeWidth: binding.value.content.strokeWidth?.toString() ?? "" };
  const [fields, setFields] = useState<Fields>(initial), draft = useRef(initial);
  const [error, setError] = useState(restored ? "较新输入已恢复，原请求仍待确认" : ""), [working, setWorking] = useState(false);
  const pending = useRef<Edit | null>(restored?.pending ?? null), running = useRef(false), needsRead = useRef(restored?.needsRead ?? false);
  const conflictRef = useRef<ShapeAppearanceConflict | null>(restored?.conflict ?? null);
  const [conflict, setConflict] = useState(conflictRef.current);
  const recovery = useRef<Create | null>(restored?.recovery ?? null);
  const copy = useRef<ShapeAppearanceCopy | null>(restored?.copy ?? null), copyPending = useRef<Edit | null>(restored?.copyPending ?? null);
  const composing = useRef(false);
  function content(input: Fields, base = value.current.content) {
    const result = { ...base };
    if (input.fill) result.fill = input.fill; else delete result.fill;
    if (input.stroke) result.stroke = input.stroke; else delete result.stroke;
    if (input.strokeWidth) result.strokeWidth = Number(input.strokeWidth); else delete result.strokeWidth;
    return result;
  }
  function valid(input: Fields) {
    return (!input.fill || /^#[0-9a-fA-F]{6}$/.test(input.fill)) &&
      (!input.stroke || /^#[0-9a-fA-F]{6}$/.test(input.stroke)) &&
      (input.strokeWidth ? Number.isFinite(Number(input.strokeWidth)) && Number(input.strokeWidth) > 0
        : original.current.content.strokeWidth === undefined);
  }
  function changed() { return JSON.stringify(content(draft.current)) !== JSON.stringify(value.current.content); }
  // Only our own ACK advances value; later raw input still needs confirmation.
  function unconfirmedAfterSave() { return value.current.versionId !== original.current.versionId && changed(); }
  function persist() {
    journal.write({ schema: 1, projectId: binding.projectId, original: original.current, value: value.current,
      fields: draft.current, pending: pending.current, needsRead: needsRead.current,
      conflict: conflictRef.current, recovery: recovery.current, ...(copy.current ? { copy: copy.current } : {}), copyPending: copyPending.current });
  }
  async function readConfirmed() {
    if (!needsRead.current) return;
    publish(await api.project(binding.projectId)); needsRead.current = false; persist();
  }
  function dismiss() {
    if (running.current || pending.current || needsRead.current || conflictRef.current || unconfirmedAfterSave()) return;
    try { journal.remove(); close(); } catch { setError("恢复记录无法移除，当前输入仍保留"); }
  }
  useLayoutEffect(() => {
    dialog.current?.showModal();
    const unload = (event: BeforeUnloadEvent) => {
      if (changed() || pending.current || needsRead.current) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", unload);
    return () => { window.removeEventListener("beforeunload", unload); dialog.current?.close(); };
  }, []);
  function change(key: keyof Fields, input: string) {
    if (running.current) return;
    draft.current = { ...draft.current, [key]: input }; setFields(draft.current);
    if (conflictRef.current && !recovery.current && valid(draft.current)) {
      conflictRef.current = { ...conflictRef.current, local: { ...conflictRef.current.local, content: content(draft.current) } };
      setConflict(conflictRef.current);
    }
    try { persist(); } catch { setError("外观草稿无法写入本机恢复记录，请保留输入并重试"); }
  }
  async function save() {
    if (running.current || composing.current || conflict || !valid(draft.current) && !pending.current && !needsRead.current) return;
    running.current = true; setWorking(true); setError("");
    try {
      while (pending.current || changed()) {
        if (!pending.current && !valid(draft.current)) {
          await readConfirmed();
          setError("原请求已确认，较新输入尚需修正后保存"); return;
        }
        const command: Edit = pending.current ?? {
          commandId: crypto.randomUUID(), projectId: binding.projectId, type: "shape.edit",
          expected: value.current.versionId, payload: { id: value.current.id, content: content(draft.current) },
        };
        pending.current = command; persist();
        const receipt = await api.execute(command);
        const version = receipt.shapeVersions?.shape ?? (receipt.changedIds.length === 0 ? command.expected : undefined);
        if (!version || receipt.projectId !== command.projectId || receipt.commandId !== command.commandId)
          throw new Error("形状外观回执不完整，原请求及输入仍保留");
        value.current = { ...value.current, versionId: version, content: command.payload.content };
        pending.current = null; needsRead.current = true; persist();
      }
      await readConfirmed();
      journal.remove(); close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "形状外观尚未保存");
      if (failure instanceof MappingError && ["VERSION_CONFLICT", "NOT_FOUND"].includes(failure.code)) {
        let latest: ProjectState;
        try {
          latest = await api.project(binding.projectId);
        } catch { setError("无法读取对方版本，原请求及完整草稿仍保留，请重试"); return; }
        // Raw fields can be invalid. Keep them separate from the last legal
        // complete proposal; a live peer read only supplies the comparison.
        const legal = valid(draft.current) ? content(draft.current) : pending.current?.payload.content ?? value.current.content;
        conflictRef.current = { local: structuredClone({ ...value.current, content: legal }),
          remote: latest.shapes?.find(shape => shape.id === value.current.id) ?? null };
        setConflict(conflictRef.current);
        try { persist(); } catch { setError("冲突草稿无法写入本机恢复记录，当前输入仍保留"); }
      }
    }
    finally { running.current = false; setWorking(false); }
  }
  async function recover() {
    const selected = conflictRef.current;
    if (!selected || running.current || composing.current) return;
    if (!recovery.current && !valid(draft.current)) { setError("请先修正较新外观字段，完整草稿仍保留"); return; }
    running.current = true; setWorking(true); setError("");
    let confirmedPose: string | undefined;
    let creationReceipt: Awaited<ReturnType<typeof api.execute>> | undefined;
    try {
      const command: Create = recovery.current ?? {
        commandId: crypto.randomUUID(), projectId: binding.projectId, type: "shape.create", expected: null,
        payload: { id: crypto.randomUUID(), content: structuredClone(selected.local.content),
          pose: { ...selected.local.item.pose } },
      };
      // Freeze both identities and the complete original content/Pose before
      // sending. Unknown ACKs retry this exact creation, never another copy.
      recovery.current = command; persist();
      const receipt = await api.execute(command);
      if (receipt.commandId !== command.commandId || receipt.projectId !== command.projectId || !receipt.shapeVersions?.shape)
        throw new Error("恢复回执不完整，原恢复请求及草稿仍保留");
      confirmedPose = receipt.shapeVersions.pose;
      creationReceipt = receipt;
      // Replaying creation never moves an already confirmed copy version back.
      copy.current ??= { versionId: receipt.shapeVersions.shape, content: command.payload.content };
      persist();
      while (copyPending.current || JSON.stringify(content(draft.current)) !== JSON.stringify(copy.current.content)) {
        if (!copyPending.current && !valid(draft.current)) {
          publish(await api.project(binding.projectId));
          setError("原恢复副本已确认，较新输入尚需修正后保存"); return;
        }
        const edit: Edit = copyPending.current ?? {
          commandId: crypto.randomUUID(), projectId: binding.projectId, type: "shape.edit", expected: copy.current.versionId,
          payload: { id: command.payload.id, content: content(draft.current) },
        };
        copyPending.current = edit; persist();
        const ack = await api.execute(edit);
        const version = ack.shapeVersions?.shape ?? (ack.changedIds.length === 0 ? edit.expected : undefined);
        if (!version || ack.commandId !== edit.commandId || ack.projectId !== edit.projectId)
          throw new Error("副本外观回执不完整，原请求及较新输入仍保留");
        copy.current = { versionId: version, content: edit.payload.content }; copyPending.current = null; persist();
      }
      publish(await api.project(binding.projectId));
      journal.remove(); close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "形状恢复尚未确认");
      if (failure instanceof MappingError && ["VERSION_CONFLICT", "NOT_FOUND"].includes(failure.code) &&
        recovery.current && copy.current && copyPending.current && confirmedPose && creationReceipt) {
        try {
          const latest = await api.project(binding.projectId);
          const remote = latest.shapes?.find(shape => shape.id === recovery.current!.payload.id) ?? null;
          // The peer supplies stable identity and comparison only. Local
          // content/Pose versions still come from this copy's own ACKs.
          const base: CanvasShape = remote ? { ...remote, versionId: copy.current.versionId, content: copy.current.content,
            item: { ...remote.item, versionId: confirmedPose, pose: { ...recovery.current.payload.pose } } }
            : await readOwnShapeRecoveryTarget(recovery.current, creationReceipt, copy.current);
          const local = { ...base, content: valid(draft.current) ? content(draft.current, base.content) : copyPending.current.payload.content };
          const nextConflict = { local, remote };
          const next: ShapeAppearanceRecord = { schema: 1, projectId: binding.projectId, original: base, value: base,
            fields: { ...draft.current }, pending: null, needsRead: false, conflict: nextConflict, recovery: null, copyPending: null };
          // A rejected edit retires only after its complete target handoff is durable.
          journal.write(next);
          original.current = base; value.current = base; pending.current = null; needsRead.current = false;
          recovery.current = null; copy.current = null; copyPending.current = null;
          conflictRef.current = nextConflict; setConflict(nextConflict);
          setError("恢复副本已更新，请比较双方后明确恢复新形状");
        } catch (readOrJournalFailure) {
          setError(readOrJournalFailure instanceof Error ? readOrJournalFailure.message : "副本比较无法保全，原请求及输入仍保留");
        }
      }
    }
    finally { running.current = false; setWorking(false); }
  }
  const preview = conflict && valid(fields) ? content(fields) : conflict?.local.content;
  return createPortal(<dialog ref={dialog} aria-label="形状外观" className="shape-appearance-dialog"
    onCancel={event => { event.preventDefault(); if (!composing.current) dismiss(); }}
    onKeyDown={event => event.stopPropagation()}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    style={{ width: 280 }}>
    <form className="shape-appearance-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h2 className="shape-appearance-heading">形状外观</h2>
      <label>填充颜色<input aria-label="填充颜色" placeholder="未设置" value={fields.fill} readOnly={working}
        onChange={event => change("fill", event.target.value)} /></label>
      <label>轮廓颜色<input aria-label="轮廓颜色" placeholder="未设置" value={fields.stroke} readOnly={working}
        onChange={event => change("stroke", event.target.value)} /></label>
      <label>轮廓粗细<input aria-label="轮廓粗细" type="number" step="any" placeholder="未设置"
        value={fields.strokeWidth} readOnly={working} onChange={event => change("strokeWidth", event.target.value)} /></label>
      <p className="shape-appearance-hint">颜色使用 #RRGGBB；粗细须大于 0。未设置的字段保持省略。</p>
      {conflict && <section aria-label="形状外观保存冲突" className="shape-appearance-conflict">
        <p>原形状已由其他调用者更新。保留对方原件，将我的完整内容和世界位置恢复为独立形状。</p>
        <label>已保存的形状内容<textarea aria-label="已保存的形状内容" readOnly rows={6}
          value={conflict.remote ? JSON.stringify(conflict.remote.content, null, 2) : "原形状已删除"} /></label>
        {conflict.remote && <label>已保存的形状位置<textarea aria-label="已保存的形状位置" readOnly rows={4}
          value={JSON.stringify(conflict.remote.item.pose, null, 2)} /></label>}
        <label>我的形状内容<textarea aria-label="我的形状内容" readOnly rows={6}
          value={JSON.stringify(preview, null, 2)} /></label>
        <label>我的形状位置<textarea aria-label="我的形状位置" readOnly rows={4}
          value={JSON.stringify(conflict.local.item.pose, null, 2)} /></label>
        <button type="button" disabled={working || !valid(fields) && !recovery.current} onClick={() => void recover()}>
          {recovery.current ? "重试恢复我的形状" : "保留对方并恢复我的形状"}
        </button>
      </section>}
      {error && <p role="alert">{error}；输入仍绑定原形状</p>}
      <div className="shape-appearance-actions">
        <button type="button" onClick={dismiss} disabled={working || !!pending.current || needsRead.current || !!conflict || unconfirmedAfterSave()}>关闭形状外观</button>
        {!conflict && <button type="submit" disabled={working || !valid(fields) && !pending.current && !needsRead.current}>{error ? "重试保存形状外观" : "保存形状外观"}</button>}
      </div>
    </form>
  </dialog>, document.body);
}
