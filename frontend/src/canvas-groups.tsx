import type { ProjectState } from './api';
import { canvasItems, selectedItemIds, type CanvasSelection } from './canvas-selection';

export function CanvasGroups({ state, selection, positions, blocked, create, enter, ungroup, remove }: {
  state: ProjectState; selection: CanvasSelection; positions: Record<string, { x: number; y: number }>;
  blocked: boolean; create: () => void; enter: (id: string) => void; ungroup: (id: string) => void;
  remove: (id: string) => void;
}) {
  const items = canvasItems(state), ids = selectedItemIds(state, selection);
  const selected = items.filter(v => ids.includes(v.item.id));
  const poses = selected.map(v => ({ ...v.item.pose, ...positions[v.item.id] }));
  const left = Math.min(...poses.map(p => p.x)), top = Math.min(...poses.map(p => p.y));
  const groupId = selection.targets.length === 1 && selection.targets[0]?.kind === 'group' ? selection.targets[0].id : null;
  return <>
    {(state.groups ?? []).map(group => {
      const members = items.filter(v => group.memberItemIds.includes(v.item.id)).map(v => ({ ...v.item.pose, ...positions[v.item.id] }));
      const x = Math.min(...members.map(p => p.x)), y = Math.min(...members.map(p => p.y));
      const right = Math.max(...members.map(p => p.x + p.width)), bottom = Math.max(...members.map(p => p.y + p.height));
      return <div key={group.id} role="group" aria-label="组合" className="canvas-group-outline" data-group-id={group.id}
        data-selected={selection.targets.some(t => t.kind === 'group' && t.id === group.id)}
        style={{ left: x - 10, top: y - 10, width: right - x + 20, height: bottom - y + 20 }} />;
    })}
    {selected.length > 0 && (selection.targets.length > 1 || groupId) && <div role="toolbar" aria-label="组合操作"
      className="canvas-group-tools nodrag nopan" style={{ left, top: top - 48 }} onPointerDown={e => e.stopPropagation()}>
      {selection.targets.length > 1 && <button disabled={blocked} onClick={create}>组合所选对象</button>}
      {groupId && <button disabled={blocked} onClick={() => enter(groupId)}>进入组合</button>}
      {groupId && <button disabled={blocked} onClick={() => ungroup(groupId)}>取消组合</button>}
      {groupId && <button disabled={blocked} onClick={() => remove(groupId)}>删除组合</button>}
    </div>}
  </>;
}
