import { ShapeCreateCommand, ShapeEditCommand, type CanvasShape } from "../../backend/src/mapping/shape-contracts";
import type { Command } from "./api";
export type ShapeAppearanceFields = { fill: string; stroke: string; strokeWidth: string };
export type ShapeAppearanceConflict = { local: CanvasShape; remote: CanvasShape | null };
export type ShapeAppearanceCopy = Pick<CanvasShape, "versionId" | "content">;
export type ShapeAppearanceRecord = {
  schema: 1; projectId: string; original: CanvasShape; value: CanvasShape; fields: ShapeAppearanceFields;
  pending: Extract<Command, { type: "shape.edit" }> | null; needsRead: boolean;
  conflict: ShapeAppearanceConflict | null; recovery: Extract<Command, { type: "shape.create" }> | null;
  copy?: ShapeAppearanceCopy; copyPending?: Extract<Command, { type: "shape.edit" }> | null;
};
const prefix = "forkwise:shape-appearance-recovery:v1:";
function shape(value: CanvasShape, projectId: string): boolean {
  return !!value && value.kind === "shape" && typeof value.versionId === "string" && !!value.versionId &&
    !!value.item && typeof value.item.id === "string" && !!value.item.id &&
    typeof value.item.versionId === "string" && !!value.item.versionId && Number.isSafeInteger(value.item.createdOrder) &&
    ShapeCreateCommand.safeParse({ commandId: "validate-record", projectId, type: "shape.create", expected: null,
      payload: { id: value.id, content: value.content, pose: value.item.pose } }).success;
}
function valid(value: ShapeAppearanceRecord): boolean {
  if (!value || value.schema !== 1 || typeof value.projectId !== "string" ||
    !shape(value.original, value.projectId) || !shape(value.value, value.projectId) ||
    value.original.id !== value.value.id || value.original.item.id !== value.value.item.id ||
    !value.fields || ![value.fields.fill, value.fields.stroke, value.fields.strokeWidth].every(field => typeof field === "string") ||
    typeof value.needsRead !== "boolean") return false;
  if (value.pending !== null && (!ShapeEditCommand.safeParse(value.pending).success ||
    value.pending.projectId !== value.projectId || value.pending.payload.id !== value.value.id ||
    value.pending.expected !== value.value.versionId)) return false;
  if (value.conflict !== null && (!value.conflict || !shape(value.conflict.local, value.projectId) ||
    value.conflict.local.id !== value.value.id || value.conflict.local.item.id !== value.value.item.id ||
    value.conflict.remote !== null && (!shape(value.conflict.remote, value.projectId) || value.conflict.remote.id !== value.value.id))) return false;
  if (value.recovery !== null && (!value.conflict || !ShapeCreateCommand.safeParse(value.recovery).success ||
    value.recovery.projectId !== value.projectId || value.recovery.payload.id === value.value.id ||
    JSON.stringify(value.recovery.payload.content) !== JSON.stringify(value.conflict.local.content) ||
    JSON.stringify(value.recovery.payload.pose) !== JSON.stringify(value.conflict.local.item.pose))) return false;
  if (value.copy !== undefined && (!value.recovery || !ShapeEditCommand.safeParse({ commandId: "validate-copy",
    projectId: value.projectId, type: "shape.edit", expected: value.copy.versionId,
    payload: { id: value.recovery.payload.id, content: value.copy.content } }).success)) return false;
  if (value.copyPending != null && (!value.copy || !value.recovery || !ShapeEditCommand.safeParse(value.copyPending).success ||
    value.copyPending.projectId !== value.projectId || value.copyPending.payload.id !== value.recovery.payload.id ||
    value.copyPending.expected !== value.copy.versionId)) return false;
  return true;
}
export class ShapeAppearanceRecovery {
  private key = prefix + crypto.randomUUID();
  damaged = false;
  constructor(private storage?: Storage) {}
  write(value: ShapeAppearanceRecord) {
    if (!valid(value)) throw new Error("形状外观恢复记录不完整，原输入仍保留");
    (this.storage ?? localStorage).setItem(this.key, JSON.stringify(value));
  }
  list(): { key: string; value: ShapeAppearanceRecord }[] {
    const storage = this.storage ?? localStorage, result = [];
    this.damaged = false;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)!;
      if (!key.startsWith(prefix) || key === this.key) continue;
      // Storage access failures propagate; malformed records remain untouched.
      const raw = storage.getItem(key);
      try {
        const value = JSON.parse(raw ?? "null") as ShapeAppearanceRecord;
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
