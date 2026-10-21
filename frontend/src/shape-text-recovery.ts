import { ShapeCreateCommand, ShapeEditCommand, type CanvasShape } from "../../backend/src/mapping/shape-contracts";
import type { Command } from "./api";
import type { ShapeTextConflict, ShapeTextSession } from "./shape-text-save";
export type ShapeTextRecord = {
  schema: 1; session: ShapeTextSession;
  pending: Extract<Command, { type: "shape.edit" }> | null;
  confirmed: { projectId: string; value: CanvasShape } | null; needsRead: boolean;
  conflict: ShapeTextConflict | null;
  recovery: Extract<Command, { type: "shape.create" }> | null;
  copy: Pick<CanvasShape, "versionId" | "content"> | null;
  copyPending: Extract<Command, { type: "shape.edit" }> | null;
};
const prefix = "forkwise:shape-text-recovery:v1:";
function shape(value: CanvasShape, projectId: string): boolean {
  return !!value && value.kind === "shape" && typeof value.versionId === "string" && !!value.versionId &&
    !!value.item && typeof value.item.id === "string" && !!value.item.id &&
    typeof value.item.versionId === "string" && !!value.item.versionId && Number.isSafeInteger(value.item.createdOrder) &&
    ShapeCreateCommand.safeParse({ commandId: "validate-record", projectId, type: "shape.create", expected: null,
      payload: { id: value.id, content: value.content, pose: value.item.pose } }).success;
}
function valid(value: ShapeTextRecord): boolean {
  const session = value?.session, projectId = session?.projectId;
  if (!value || value.schema !== 1 || !session || typeof projectId !== "string" || typeof session.input !== "string" ||
    !shape(session.value, projectId) || typeof value.needsRead !== "boolean") return false;
  if (!value.confirmed || value.confirmed.projectId !== projectId || !shape(value.confirmed.value, projectId) ||
    JSON.stringify(value.confirmed.value) !== JSON.stringify(session.value)) return false;
  if (value.pending !== null && (!ShapeEditCommand.safeParse(value.pending).success ||
    value.pending.projectId !== projectId || value.pending.payload.id !== session.value.id ||
    value.pending.expected !== session.value.versionId)) return false;
  if (value.conflict !== null && (!value.conflict || value.conflict.remote !== null &&
    (!shape(value.conflict.remote, projectId) || value.conflict.remote.id !== session.value.id))) return false;
  if (value.recovery !== null && (!value.conflict || !ShapeCreateCommand.safeParse(value.recovery).success ||
    value.recovery.projectId !== projectId || value.recovery.payload.id === session.value.id ||
    JSON.stringify(value.recovery.payload.pose) !== JSON.stringify(session.value.item.pose))) return false;
  if (value.copy !== null && (!value.recovery || !ShapeEditCommand.safeParse({ commandId: "validate-copy",
    projectId, type: "shape.edit", expected: value.copy.versionId,
    payload: { id: value.recovery.payload.id, content: value.copy.content } }).success)) return false;
  if (value.copyPending !== null && (!value.copy || !value.recovery || !ShapeEditCommand.safeParse(value.copyPending).success ||
    value.copyPending.projectId !== projectId || value.copyPending.payload.id !== value.recovery.payload.id ||
    value.copyPending.expected !== value.copy.versionId)) return false;
  return true;
}
export class ShapeTextRecovery {
  private key = prefix + crypto.randomUUID();
  damaged = false;
  constructor(private storage?: Storage) {}
  write(value: ShapeTextRecord) {
    if (!valid(value)) throw new Error("形状文字恢复记录不完整，原输入仍保留");
    (this.storage ?? localStorage).setItem(this.key, JSON.stringify(value));
  }
  list(): { key: string; value: ShapeTextRecord }[] {
    const storage = this.storage ?? localStorage, result = [];
    this.damaged = false;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)!;
      if (!key.startsWith(prefix) || key === this.key) continue;
      const raw = storage.getItem(key); // Storage failures propagate; do not treat them as an empty journal.
      try {
        const value = JSON.parse(raw ?? "null") as ShapeTextRecord;
        if (!valid(value)) { this.damaged = true; continue; }
        result.push({ key, value });
      } catch { this.damaged = true; }
    }
    return result;
  }
  remove(key = this.key) {
    if (!key.startsWith(prefix)) throw new Error("不能移除未知恢复记录");
    (this.storage ?? localStorage).removeItem(key);
  }
}
