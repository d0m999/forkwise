import { ShapeCreateCommand, ShapeEditCommand, type CanvasShape } from "../../backend/src/mapping/shape-contracts";
import type { Command, Receipt } from "../../backend/src/mapping/contracts";
import { api } from "./api";

// Only a confirmed creation owns this item identity. A missing live target must
// not borrow the original shape's item or a peer's later content/Pose version.
export async function readOwnShapeRecoveryTarget(
  command: Extract<Command, { type: "shape.create" }>, receipt: Receipt,
  own: Pick<CanvasShape, "versionId" | "content">,
): Promise<CanvasShape> {
  const versions = receipt.shapeVersions, ids = receipt.changedIds;
  if (!ShapeCreateCommand.safeParse(command).success || receipt.commandId !== command.commandId ||
    receipt.projectId !== command.projectId || typeof versions?.shape !== "string" || !versions.shape ||
    typeof versions.pose !== "string" || !versions.pose ||
    !Array.isArray(ids) || ids.length !== 2 || !ids.includes(command.payload.id) ||
    !ids.every(id => typeof id === "string" && !!id) || new Set(ids).size !== 2 ||
    !ShapeEditCommand.safeParse({ commandId: "validate-own-copy", projectId: command.projectId,
      type: "shape.edit", expected: own.versionId, payload: { id: command.payload.id, content: own.content } }).success)
    throw new Error("恢复副本身份回执不完整，原请求及输入仍保留");
  const itemId = ids.find(id => id !== command.payload.id)!;
  const item = await api.poseVersion(command.projectId, itemId, versions.pose);
  if (!item || item.id !== itemId || item.versionId !== versions.pose || !Number.isSafeInteger(item.createdOrder) ||
    !ShapeCreateCommand.safeParse({ ...command, payload: { ...command.payload, content: own.content, pose: item.pose } }).success ||
    !(["x", "y", "width", "height"] as const).every(key => item.pose[key] === command.payload.pose[key]))
    throw new Error("恢复副本位置身份无法确认，原请求及输入仍保留");
  return { id: command.payload.id, kind: "shape", versionId: own.versionId, content: own.content, item };
}
