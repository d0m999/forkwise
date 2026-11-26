import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { groupOutlineBounds } from '../../backend/src/mapping/container-endpoints';
import type { ProjectState } from './api';
import { canvasItems, selectedItemIds, type CanvasSelection } from './canvas-selection';
import type { useGroupGeometry } from './group-geometry';
import { LayerMenu, type LayerMenuProps } from './layer-menu';
import { useNearbyCanvasControls } from './nearby-canvas-controls';

export function CanvasGroups({ state, selection, positions, geometry, blocked, create, createFrame, enter, ungroup, ungroupSelected, remove, layer }: {
  state: ProjectState; selection: CanvasSelection; positions: Record<string, { x: number; y: number; width?: number; height?: number }>;
  geometry: ReturnType<typeof useGroupGeometry>;
  blocked: boolean; create: () => void; createFrame: () => void; enter: (id: string) => void; ungroup: (id: string) => void;
  ungroupSelected: () => void; remove: (id: string) => void; layer?: LayerMenuProps | undefined;
}) {
  const items = canvasItems(state), ids = selectedItemIds(state, selection);
  const selected = items.filter(v => ids.includes(v.item.id));
  const poses = selected.map(v => ({ ...v.item.pose, ...positions[v.item.id] }));
  const left = Math.min(...poses.map(p => p.x)), top = Math.min(...poses.map(p => p.y));
  const right = Math.max(...poses.map(p => p.x + p.width)), bottom = Math.max(...poses.map(p => p.y + p.height));
  const groupId = selection.targets.length === 1 && selection.targets[0]?.kind === 'group' ? selection.targets[0].id : null;
  const anchor = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const showTools = selected.length > 0 && (selection.targets.length > 1 || !!groupId);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setPortal(anchor.current?.closest<HTMLElement>(".canvas") ?? null);
  }, [showTools]);
  const { positions: placement, placePopup } = useNearbyCanvasControls(anchor, toolbar, undefined, showTools && !!portal);
  return <>
    {(state.groups ?? []).map(group => {
      const members = items.filter(v => group.memberItemIds.includes(v.item.id)).map(v => ({ ...v.item.pose, ...positions[v.item.id] }));
      const { x, y, width, height } = groupOutlineBounds(members);
      return <div key={group.id} role="group" aria-label="组合" className="canvas-group-outline" data-group-id={group.id}
        data-selected={selection.targets.some(t => t.kind === 'group' && t.id === group.id)}
        style={{ left: x, top: y, width, height }} />;
    })}
    {geometry.scalable && (['nw', 'ne', 'sw', 'se'] as const).map(corner => <button key={corner}
      className="card-resize nodrag nopan" aria-label={`调整组合尺寸：${({ nw: '左上', ne: '右上', sw: '左下', se: '右下' })[corner]}`}
      disabled={blocked || geometry.blocked} style={{ position: 'absolute', left: (corner.endsWith('w') ? left : right) - 5,
        top: (corner.startsWith('n') ? top : bottom) - 5, zIndex: 1001, pointerEvents: 'auto', cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize' }}
      onPointerDown={event => geometry.start(event, corner)} />)}
    {showTools && <>
      <div ref={anchor} aria-hidden="true" className="canvas-selection-anchor"
        style={{ left, top, width: right - left, height: bottom - top }} />
      {portal && createPortal(<div ref={toolbar} role="toolbar" aria-label="组合操作"
        className="canvas-group-tools card-floating nodrag nopan"
        style={{ ...placement?.toolbar, maxWidth: placement?.maxWidth, visibility: placement ? undefined : "hidden" }}
        onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      {selection.targets.length > 1 && <><button disabled={blocked} onClick={create}>组合所选对象</button><span>不含连线</span></>}
      {selection.targets.length > 0 && (() => {
        const parents = selection.targets.map(target => {
          const id = target.kind === 'item' ? target.itemId : state.groups?.find(g => g.id === target.id)?.itemId;
          return state.containment?.find(v => v.id === id)?.parent ?? null;
        });
        return parents.every(v => v?.kind !== 'group' && (v?.id ?? null) === (parents[0]?.id ?? null));
      })() && <button disabled={blocked} onClick={createFrame}>创建分区</button>}
      {selection.targets.length > 1 && selection.targets.every(target => target.kind === 'group') && <button disabled={blocked} onClick={ungroupSelected}>取消所选组合</button>}
      {groupId && <button disabled={blocked} onClick={() => enter(groupId)}>进入组合</button>}
      {groupId && <button disabled={blocked} onClick={() => ungroup(groupId)}>取消组合</button>}
      {groupId && <button disabled={blocked} onClick={() => remove(groupId)}>删除组合</button>}
      {geometry.rotatable && <><button disabled={blocked || geometry.blocked} onClick={() => void geometry.rotate('left')}>组合左转90°</button>
        <button disabled={blocked || geometry.blocked} onClick={() => void geometry.rotate('right')}>组合右转90°</button></>}
      {selection.targets.some(t => t.kind === 'group') && !geometry.scalable && <span>含笔迹，暂仅支持整体移动</span>}
      {layer && <LayerMenu {...layer} placePopup={placePopup} />}
    </div>, portal)}
    </>}
  </>;
}
