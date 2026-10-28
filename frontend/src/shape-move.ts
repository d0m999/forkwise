import { useRef, useState } from "react";
import { api, MappingError, type Command, type ProjectState } from "./api";
import type { CanvasShape } from "../../backend/src/mapping/shape-contracts";
type Point = { x: number; y: number };
type Pose = CanvasShape["item"]["pose"];
type Geometry = Extract<Command, { type: "shape.move" | "shape.transform" }>;
type Target = { projectId: string; value: CanvasShape; transform: boolean };
type Conflict = { commandId: string; type: Geometry["type"]; local: Pose; remote: CanvasShape };
type KeyIntent = { projectId: string; id: string; itemId: string; adjust: (pose: Pose) => Pose | null; commandId: string | null };

export function useShapeMove(
  authority: () => ProjectState | null,
  publish: (value: ProjectState) => void,
  before: () => Promise<boolean>,
  acknowledged?: (command: Geometry, receipt: Awaited<ReturnType<typeof api.execute>>) => void,
) {
  const gesture = useRef<Target | null>(null), pending = useRef<{ target: Target; command: Geometry } | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const lastAck = useRef<{ commandId: string; target: Target } | null>(null);
  const keyQueue = useRef<KeyIntent[]>([]), keyBase = useRef<Target | null>(null), keyDependency = useRef<string | null>(null);
  const keySaving = useRef<Promise<boolean> | null>(null), [keyCount, setKeyCount] = useState(0);
  const conflictRef = useRef<Conflict | null>(null), [conflict, setConflict] = useState<Conflict | null>(null);
  const deletedRef = useRef<Target | null>(null), [deleted, setDeleted] = useState<Target | null>(null);
  const [positions, setPositions] = useState<Record<string, Pose>>({});
  const [dragging, setDragging] = useState(false), [waiting, setWaiting] = useState(false), [error, setError] = useState("");
  function start(itemId: string, transform = false) {
    if (gesture.current || pending.current || running.current || keyQueue.current.length || keySaving.current) return false;
    const state = authority(), value = state?.shapes?.find(shape => shape.item.id === itemId);
    if (!state || !value) return false;
    gesture.current = { projectId: state.project.id, value: structuredClone(value), transform };
    setDragging(true); setError(""); return true;
  }
  function preview(itemId: string, point: Point) {
    if (gesture.current?.value.item.id !== itemId) {
      if (!pending.current) setPositions({});
      return;
    }
    if (gesture.current.transform) return;
    setPositions({ [itemId]: { ...gesture.current.value.item.pose, x: point.x, y: point.y } });
  }
  function previewTransform(itemId: string, pose: Pose) {
    if (gesture.current?.value.item.id === itemId && gesture.current.transform) setPositions({ [itemId]: pose });
  }
  function cancel() {
    // Invalidate synchronously so a late engine move/up cannot revive preview.
    gesture.current = null; setDragging(false);
    if (!pending.current) setPositions({});
  }
  function sameTarget(a: Target, b: Target) {
    return a.projectId === b.projectId && a.value.id === b.value.id && a.value.item.id === b.value.item.id;
  }
  function confirmedDeleted(target: Target, latest: ProjectState) {
    if (authority()?.project.id !== target.projectId || latest.project.id !== target.projectId)
      throw new Error("项目已变化，原形状调整仍保留");
    if (latest.shapes?.some(shape => shape.id === target.value.id || shape.item.id === target.value.item.id)) return false;
    publish(latest); deletedRef.current = target; setDeleted(target);
    setError("形状目标已删除，请明确取消本次未完成的调整"); return true;
  }
  async function discardDeleted() {
    const selected = deletedRef.current;
    if (!selected) return;
    // Keep the entry visible while an already finishing owner settles.
    if (running.current) await running.current;
    if (keySaving.current) await keySaving.current;
    if (deletedRef.current !== selected || authority()?.project.id !== selected.projectId) return;
    if ([gesture.current, pending.current?.target, keyBase.current].some(target => target && !sameTarget(target, selected)) ||
      keyQueue.current.some(intent => intent.projectId !== selected.projectId || intent.id !== selected.value.id || intent.itemId !== selected.value.item.id)) return;
    gesture.current = null; pending.current = null; keyQueue.current = []; keyBase.current = null; keyDependency.current = null;
    if (lastAck.current && sameTarget(lastAck.current.target, selected)) lastAck.current = null;
    conflictRef.current = null; setConflict(null); deletedRef.current = null; setDeleted(null);
    setPositions(previous => { const next = { ...previous }; delete next[selected.value.item.id]; return next; });
    setKeyCount(0); setDragging(false); setWaiting(false); setError("");
  }
  async function retry(): Promise<boolean> {
    if (running.current) return running.current;
    if (conflictRef.current) return false;
    if (!pending.current) return keyQueue.current.length ? drainKeys() : true;
    deletedRef.current = null; setDeleted(null);
    setWaiting(true); setError("");
    running.current = (async () => {
      const { target, command } = pending.current!;
      try {
        if (!(await before())) throw new Error("请先确认输入保存，原形状移动仍保留");
        const state = authority();
        // A synchronized deletion cannot invalidate a frozen request: its
        // successful receipt may already exist even though the target is gone.
        if (state?.project.id !== target.projectId)
          throw new Error("形状移动目标已变化，原请求仍保留");
        const receipt = await api.execute(command);
        const poseVersion = receipt.shapeVersions?.pose ?? (receipt.changedIds.length === 0 ? command.expected : undefined);
        if (receipt.commandId !== command.commandId || receipt.projectId !== command.projectId || !poseVersion)
          throw new Error("形状位置回执不完整，原请求仍保留");
        acknowledged?.(command, receipt);
        const pose = command.type === "shape.transform" ? command.payload.pose
          : { ...target.value.item.pose, x: command.payload.x, y: command.payload.y };
        lastAck.current = { commandId: command.commandId, target: { ...target, transform: true,
          value: { ...target.value, item: { ...target.value.item, versionId: poseVersion, pose } } } };
        const latest = await api.project(command.projectId);
        if (authority()?.project.id !== command.projectId) throw new Error("项目已变化，原形状移动仍保留");
        publish(latest); pending.current = null; setPositions({}); return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "形状位置保存未确认");
        if (failure instanceof MappingError && ["VERSION_CONFLICT", "NOT_FOUND"].includes(failure.code)) {
          try {
            const latest = await api.project(command.projectId);
            const remote = latest.shapes?.find(shape => shape.id === target.value.id && shape.item.id === target.value.item.id);
            if (confirmedDeleted(target, latest)) return false;
            if (authority()?.project.id === command.projectId && remote && failure.code === "VERSION_CONFLICT") {
              const local = command.type === "shape.transform" ? command.payload.pose
                : { ...target.value.item.pose, x: command.payload.x, y: command.payload.y };
              const value = { commandId: command.commandId, type: command.type, local, remote };
              conflictRef.current = value; setConflict(value);
            } else setError("形状目标已变化，原位置请求仍保留");
          } catch { setError("无法读取对方位置，原请求及本次位置仍保留，请重试"); }
        }
        return false;
      }
    })();
    const result = await running.current; running.current = null; setWaiting(false);
    if (result) void drainKeys();
    return result;
  }
  function resolveConflict() {
    const selected = conflictRef.current, current = pending.current;
    if (!selected || !current || running.current || selected.commandId !== current.command.commandId) return;
    // Only this explicit choice authorizes a new command from the compared
    // peer Pose version. Unknown outcomes keep retrying the original command.
    const previousId = current.command.commandId;
    current.command = { ...current.command, commandId: crypto.randomUUID(), expected: selected.remote.item.versionId };
    if (current.command.type === "shape.move") current.target.value = { ...current.target.value,
      item: { ...current.target.value.item, pose: selected.remote.item.pose } };
    if (keyDependency.current === previousId) keyDependency.current = current.command.commandId;
    for (const intent of keyQueue.current) if (intent.commandId === previousId) intent.commandId = current.command.commandId;
    conflictRef.current = null; setConflict(null); setError("");
    void retry();
  }
  function finish(itemId: string, point: Point) {
    const target = gesture.current;
    if (!target || target.transform || target.value.item.id !== itemId) return;
    gesture.current = null; setDragging(false);
    if (point.x === target.value.item.pose.x && point.y === target.value.item.pose.y) { setPositions({}); return; }
    const command: Geometry = { commandId: crypto.randomUUID(), projectId: target.projectId, type: "shape.move",
      expected: target.value.item.versionId, payload: { id: target.value.id, x: point.x, y: point.y } };
    pending.current = { target, command }; setPositions({ [itemId]: { ...target.value.item.pose, ...point } }); setWaiting(true);
    void retry();
  }
  function finishTransform(itemId: string, pose: Pose) {
    const target = gesture.current;
    if (!target || !target.transform || target.value.item.id !== itemId) return;
    gesture.current = null; setDragging(false);
    if (JSON.stringify(pose) === JSON.stringify(target.value.item.pose)) { setPositions({}); return; }
    const command: Geometry = { commandId: crypto.randomUUID(), projectId: target.projectId, type: "shape.transform",
      expected: target.value.item.versionId, payload: { id: target.value.id, pose: { ...pose } } };
    pending.current = { target, command }; setPositions({ [itemId]: pose }); setWaiting(true);
    void retry();
  }
  async function flush() {
    if (gesture.current) return false;
    if (keySaving.current) return keySaving.current;
    if (running.current) return running.current;
    return !pending.current && !keyQueue.current.length;
  }
  async function drainKeys(): Promise<boolean> {
    if (keySaving.current) return keySaving.current;
    if (!keyQueue.current.length) return true;
    keySaving.current = (async () => {
      if (keyDependency.current) {
        if (running.current && !(await running.current)) return false;
        if (pending.current || lastAck.current?.commandId !== keyDependency.current) return false;
        keyBase.current = lastAck.current.target; keyDependency.current = null;
      }
      while (keyQueue.current.length) {
        const intent = keyQueue.current[0]!;
        if (intent.commandId) {
          if (pending.current || lastAck.current?.commandId !== intent.commandId) return false;
          keyBase.current = lastAck.current.target; keyQueue.current.shift(); continue;
        }
        const base = keyBase.current, state = authority();
        if (!base || state?.project.id !== intent.projectId || base.projectId !== intent.projectId ||
          base.value.id !== intent.id || base.value.item.id !== intent.itemId) {
          setError("形状键盘目标已变化，原意图仍保留"); return false;
        }
        if (!state.shapes?.some(shape => shape.id === intent.id && shape.item.id === intent.itemId)) {
          deletedRef.current = null; setDeleted(null);
          try {
            if (!confirmedDeleted(base, await api.project(intent.projectId))) setError("形状键盘目标已变化，原意图仍保留");
          } catch { setError("无法确认形状目标，原键盘调整仍保留，请重试"); }
          return false;
        }
        const pose = intent.adjust(base.value.item.pose);
        if (!pose) { keyQueue.current.shift(); continue; }
        const command: Geometry = { commandId: crypto.randomUUID(), projectId: intent.projectId, type: "shape.transform",
          expected: base.value.item.versionId, payload: { id: intent.id, pose } };
        intent.commandId = command.commandId; pending.current = { target: base, command };
        setPositions({ [intent.itemId]: pose });
        if (!(await retry())) return false;
      }
      keyBase.current = null; return true;
    })();
    const result = await keySaving.current; keySaving.current = null; setKeyCount(keyQueue.current.length); return result;
  }
  function enqueueTransform(itemId: string, adjust: (pose: Pose) => Pose | null) {
    if (gesture.current) return;
    const state = authority(), value = state?.shapes?.find(shape => shape.item.id === itemId);
    if (!state || !value) return;
    const owner = pending.current?.target ?? keyBase.current;
    if (owner && (owner.projectId !== state.project.id || owner.value.id !== value.id || owner.value.item.id !== itemId)) return;
    if (!keyQueue.current.length && !keySaving.current) {
      keyDependency.current = pending.current?.command.commandId ?? null;
      keyBase.current = keyDependency.current ? null : { projectId: state.project.id, value: structuredClone(value), transform: true };
    }
    keyQueue.current.push({ projectId: state.project.id, id: value.id, itemId, adjust, commandId: null });
    setKeyCount(keyQueue.current.length); void drainKeys();
  }
  const transforming = !!keyCount || gesture.current?.transform || pending.current?.command.type === "shape.transform";
  const label = transforming ? "形状尺寸" : "形状位置";
  return { start, preview, finish, startTransform: (id: string) => start(id, true), previewTransform, finishTransform, enqueueTransform,
    confirmed: () => lastAck.current?.target ?? null,
    cancel, flush, retry, resolveConflict, conflict, deleted, discardDeleted, positions, dragging, transforming, working: waiting, pending: waiting || !!keyCount || !!pending.current,
    hasPending: () => !!gesture.current || !!pending.current || !!running.current || !!keyQueue.current.length,
    error, status: error ? label + "保存未完成" : waiting || keyCount ? label + "正在保存…" : dragging ? "形状正在调整…" : "" };
}
