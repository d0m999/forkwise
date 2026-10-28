import { useRef, useState } from "react";
import { api, type Command, type ProjectState } from "./api";
import { MappingCommand } from "../../backend/src/mapping/contracts";

type Move = Extract<Command, { type: 'canvas.move' | 'canvas.move-selection' }>;
type Point = { x: number; y: number };
export type CanvasMoveIntent = { targets: {
  kind: 'card' | 'text' | 'shape' | 'image' | 'stroke';
  id: string; itemId: string; poseVersionId: string;
  pose: (Point & { width: number; height: number; rotation?: number }) | null;
  x: number; y: number;
}[] };
type Conflict = CanvasMoveIntent & { command: Move; saved: { itemId: string; position?: Point | null }[] };
const prefix = "forkwise:canvas-move-conflict:v1:";
const point = (value: unknown): value is Point => !!value && typeof value === 'object' &&
  Number.isFinite((value as Point).x) && Number.isFinite((value as Point).y);

export function useCanvasMoveConflict(publish: (state: ProjectState) => void) {
  const [key] = useState(() => prefix + crypto.randomUUID());
  const current = useRef<Conflict | null>(null);
  const identity = useRef<object | null>(null);
  const [value, setValue] = useState<Conflict | null>(null), [error, setError] = useState("");
  function list() {
    const records: { key: string; value: Conflict }[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index)!;
      if (!name.startsWith(prefix) || name === key) continue;
      try {
        const record = JSON.parse(localStorage.getItem(name)!);
        const parsed = MappingCommand.safeParse(record.value?.command);
        if (!parsed.success || (parsed.data.type !== 'canvas.move' && parsed.data.type !== 'canvas.move-selection')) continue;
        const command = parsed.data, saved = record.value.saved;
        // Legacy records contain destinations and saved comparisons, but no
        // original Pose. Preserve that absence rather than inventing one.
        const targets: CanvasMoveIntent['targets'] | undefined = record.schema === 1 && command.type === 'canvas.move'
          ? command.payload.targets.map(target => ({ ...target, poseVersionId: command.expected[target.itemId]!, pose: null }))
          : record.schema === 2 ? record.value.targets : undefined;
        if (!Array.isArray(targets) || !Array.isArray(saved) || saved.length !== targets.length || !targets.length) continue;
        const poses = command.type === 'canvas.move' ? command.expected : command.expected.poses;
        if (Object.keys(poses).length !== targets.length || new Set(targets.map(target => target.itemId)).size !== targets.length) continue;
        if (!targets.every(target => ['card', 'text', 'shape', 'image', 'stroke'].includes(target.kind) &&
          typeof target.id === 'string' && typeof target.itemId === 'string' && poses[target.itemId] === target.poseVersionId && point(target) &&
          (target.pose === null || point(target.pose) && Number.isFinite(target.pose.width) && Number.isFinite(target.pose.height) &&
            (target.pose.rotation === undefined || Number.isFinite(target.pose.rotation))))) continue;
        if (command.type === 'canvas.move' && !targets.every((target, i) => {
          const original = command.payload.targets[i];
          return original && target.kind === original.kind && target.id === original.id && target.itemId === original.itemId && target.x === original.x && target.y === original.y;
        })) continue;
        if (!saved.every((row, i) => row?.itemId === targets[i]!.itemId &&
          (row.position === undefined || row.position === null || point(row.position)))) continue;
        records.push({ key: name, value: { command, targets, saved } });
      } catch { /* Unknown records remain untouched. */ }
    }
    return records;
  }
  const [recoveries, setRecoveries] = useState(list);
  function store(next: Conflict, install = false) {
    localStorage.setItem(key, JSON.stringify({ schema: 2, value: next }));
    if (install) identity.current = {};
    current.current = next; setValue(next); setError("");
  }
  async function readSaved() {
    const record = current.current;
    if (!record) return false;
    const owner = identity.current;
    try {
      const latest = await api.project(record.command.projectId);
      if (identity.current !== owner) return false;
      const saved = record.targets.map(target => {
        const object = (target.kind === 'card' ? latest.cards : target.kind === 'shape' ? latest.shapes :
          target.kind === 'image' ? latest.images : target.kind === 'stroke' ? latest.strokes : latest.texts)?.find(item => item.id === target.id && item.item.id === target.itemId);
        return { itemId: target.itemId, position: object ? { x: object.item.pose.x, y: object.item.pose.y } : null };
      });
      store({ ...record, saved });
      return true;
    } catch { if (identity.current === owner) setError('无法读取已保存位置，原移动意图仍保留，请重试读取'); return false; }
  }
  async function open(command: Move, intent?: CanvasMoveIntent) {
    const targets = intent?.targets ?? (command.type === 'canvas.move' ? command.payload.targets.map(target =>
      ({ ...target, poseVersionId: command.expected[target.itemId]!, pose: null })) : null);
    if (!targets) throw new Error('原移动成员意图未提供，拒绝请求仍保留');
    // Persistence transfers the rejected request to this existing owner. A
    // comparison read may fail afterwards without sending that request again.
    store({ command, targets: structuredClone(targets), saved: targets.map(target => ({ itemId: target.itemId })) }, true);
    await readSaved();
  }
  function recover(name: string) {
    if (current.current) return;
    const record = list().find(entry => entry.key === name);
    if (!record) return;
    try { store(record.value, true); localStorage.removeItem(name); setRecoveries(list()); void readSaved(); }
    catch { setError("无法接管混合移动恢复记录，请保留原意图"); }
  }
  async function abandon() {
    const record = current.current;
    if (!record) return;
    const owner = identity.current;
    try {
      const latest = await api.project(record.command.projectId);
      if (identity.current !== owner) return;
      localStorage.removeItem(key); identity.current = null; current.current = null; setValue(null); setError(""); publish(latest);
    } catch { if (identity.current === owner) setError("无法读取成员已保存位置，本次移动意图仍保留，请重新读取"); }
  }
  return { value, open, recover, abandon, retry: readSaved, recoveries, error, hasPending: () => !!current.current,
    status: value ? "混合移动存在保存冲突" : recoveries.length ? "有待恢复的混合移动草稿" : "" };
}
export function CanvasMoveConflictPanel({ value, abandon }: { value: Conflict; abandon: () => Promise<void> }) {
  return <section className="conflict-panel" aria-label="混合移动保存冲突">
    <h2>混合移动未保存</h2>
    <p>全部成员均未按本次意图移动。对比整组位置后，可明确放弃本次移动，保留当前已保存位置。</p>
    <table><thead><tr><th>对象</th><th>原位置</th><th>本次移动位置</th><th>已保存位置</th></tr></thead>
      <tbody>{value.targets.map((target, index) => <tr key={target.itemId}>
        <td>{target.kind === 'card' ? '卡片' : target.kind === 'shape' ? '形状' : target.kind === 'image' ? '图片' : target.kind === 'stroke' ? '笔迹' : '文字'} {index + 1}</td>
        <td>{target.pose ? `${target.pose.x}, ${target.pose.y}` : '原位置未记录'}</td>
        <td>{target.x}, {target.y}</td>
        <td>{value.saved[index]?.position === undefined ? '尚未读取' : value.saved[index]!.position === null ? '对象已删除' : `${value.saved[index]!.position!.x}, ${value.saved[index]!.position!.y}`}</td>
      </tr>)}</tbody></table>
    <button onClick={() => void abandon()}>放弃本次混合移动，保留已保存位置</button>
  </section>;
}
