import { useRef, useState } from "react";
import { api, type Command, type ProjectState } from "./api";
import { MappingCommand } from "../../backend/src/mapping/contracts";
type Move = Extract<Command, { type: "canvas.move" }>;
type Conflict = { command: Move; saved: { itemId: string; position: { x: number; y: number } | null }[] };
const prefix = "forkwise:canvas-move-conflict:v1:";
export function useCanvasMoveConflict(publish: (state: ProjectState) => void) {
  const [key] = useState(() => prefix + crypto.randomUUID());
  const current = useRef<Conflict | null>(null);
  const [value, setValue] = useState<Conflict | null>(null), [error, setError] = useState("");
  function list() {
    const records: { key: string; value: Conflict }[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index)!;
      if (!name.startsWith(prefix) || name === key) continue;
      try {
        const record = JSON.parse(localStorage.getItem(name)!);
        const parsed = MappingCommand.safeParse(record.value?.command);
        const saved = record.value?.saved;
        if (record.schema !== 1 || !parsed.success || parsed.data.type !== "canvas.move" || !Array.isArray(saved) || saved.length !== parsed.data.payload.targets.length) continue;
        const command = parsed.data;
        if (!saved.every((row, i) => row.itemId === command.payload.targets[i]?.itemId && (row.position === null || (Number.isFinite(row.position?.x) && Number.isFinite(row.position?.y))))) continue;
        records.push({ key: name, value: { command: parsed.data, saved } });
      } catch { /* Unknown records remain untouched. */ }
    }
    return records;
  }
  const [recoveries, setRecoveries] = useState(list);
  function store(next: Conflict) {
    localStorage.setItem(key, JSON.stringify({ schema: 1, value: next }));
    current.current = next; setValue(next); setError("");
  }
  async function open(command: Move) {
    const latest = await api.project(command.projectId);
    store({ command, saved: command.payload.targets.map((target) => {
      const object = (target.kind === "card" ? latest.cards : latest.texts)?.find((item) => item.id === target.id && item.item.id === target.itemId);
      return { itemId: target.itemId, position: object ? { x: object.item.pose.x, y: object.item.pose.y } : null };
    }) });
  }
  function recover(name: string) {
    if (current.current) return;
    const record = list().find((entry) => entry.key === name);
    if (!record) return;
    try { store(record.value); localStorage.removeItem(name); setRecoveries(list()); }
    catch { setError("无法接管混合移动恢复记录，请保留原意图"); }
  }
  async function abandon() {
    const record = current.current;
    if (!record) return;
    try {
      const latest = await api.project(record.command.projectId);
      // Explicit abandonment reads current authority; it never endorses the
      // rejected positions with fresh versions or writes any member again.
      localStorage.removeItem(key); current.current = null; setValue(null); setError(""); publish(latest);
    } catch { setError("无法读取已保存位置，请保留本次移动意图并重试"); }
  }
  return { value, open, recover, abandon, recoveries, error, hasPending: () => !!current.current,
    status: value ? "混合移动存在保存冲突" : recoveries.length ? "有待恢复的混合移动草稿" : "" };
}
export function CanvasMoveConflictPanel({ value, abandon }: { value: Conflict; abandon: () => Promise<void> }) {
  return <section className="conflict-panel" aria-label="混合移动保存冲突">
    <h2>混合移动未保存</h2>
    <p>全部成员均未按本次意图移动。对比整组位置后，可明确放弃本次移动，保留当前已保存位置。</p>
    <table><thead><tr><th>对象</th><th>本次移动位置</th><th>已保存位置</th></tr></thead>
      <tbody>{value.command.payload.targets.map((target, index) => <tr key={target.itemId}>
        <td>{target.kind === "card" ? "卡片" : "文字"} {index + 1}</td>
        <td>{target.x}, {target.y}</td>
        <td>{value.saved[index]?.position ? `${value.saved[index]!.position!.x}, ${value.saved[index]!.position!.y}` : "对象已删除"}</td>
      </tr>)}</tbody></table>
    <button onClick={() => void abandon()}>放弃本次混合移动，保留已保存位置</button>
  </section>;
}
