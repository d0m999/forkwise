import { captureSpatial, frameCandidate, frameDescendants, frameResizePlan } from '../../backend/src/mapping/frame-spatial';
import { Fragment, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Command, ProjectState } from './api';
import { deleteFrameCommand, frameMovingItemIds, moveFrameCommand, resizedFrameRect, frameHandleNames, type FrameRect } from './canvas-frame-commands';
import type { CanvasFrame } from '../../backend/src/mapping/frame-contracts';

type Point = { x: number; y: number };
type FrameCommand = Extract<Command, { type: 'frame.edit' | 'frame.move' | 'frame.delete' | 'frame.resize' }>;
type Execute = (command: FrameCommand, onDone: () => void, endEditing?: () => void) => void;

export function useFrameMove({ state, blocked, point, execute }: {
  state: ProjectState | null; blocked: boolean; point: (client: Point) => Point; execute: Execute;
}) {
  const latest = useRef({ state, blocked, point, execute });
  latest.current = { state, blocked, point, execute };
  const [positions, setPositions] = useState<Record<string, Point & { width?: number; height?: number }>>({});
  const session = useRef<{ state: ProjectState; frame: CanvasFrame; start: Point; dx: number; dy: number; mode: 'move' | 'resize'; corner?: string; rect?: FrameRect } | null>(null);
  const moved = useRef(new Set<string>());
  const keyboard = useRef<{ state: ProjectState; frame: CanvasFrame; corner: string; rect: FrameRect } | null>(null);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [membershipPreview, setMembershipPreview] = useState<{ attach: string[]; release: string[] } | null>(null);
  useEffect(() => {
    function project(event: PointerEvent) {
      const current = session.current;
      if (!current) return null;
      const next = latest.current.point({ x: event.clientX, y: event.clientY });
      current.dx = next.x - current.start.x; current.dy = next.y - current.start.y;
      if (current.dx || current.dy) moved.current.add(current.frame.id);
      if (current.mode === 'resize') {
        current.rect = resizedFrameRect(current.frame.pose, current.corner!, current.dx, current.dy);
        setPositions({ [current.frame.id]: current.rect });
        setMembershipPreview(frameResizePlan(current.state, current.frame.id, current.rect));
        return current;
      }
      setCandidateId(frameCandidate(current.state, next, [current.frame.id])?.id ?? null);
      const children = (current.state.frames ?? []).filter(v => v.id !== current.frame.id && frameDescendants(current.state, [current.frame.id]).has(v.id))
        .map(v => [v.id, { x: v.pose.x + current.dx, y: v.pose.y + current.dy }] as const);
      const members = frameMovingItemIds(current.state, current.frame).flatMap(id => {
        const item = [...current.state.cards, ...(current.state.texts ?? []), ...(current.state.shapes ?? []),
          ...(current.state.images ?? []), ...(current.state.strokes ?? [])].find(value => value.item.id === id);
        return item ? [[id, { x: item.item.pose.x + current.dx, y: item.item.pose.y + current.dy }] as const] : [];
      });
      setPositions(Object.fromEntries([[current.frame.id, { x: current.frame.pose.x + current.dx, y: current.frame.pose.y + current.dy }], ...children, ...members]));
      return current;
    }
    const move = (event: PointerEvent) => { project(event); };
    const up = (event: PointerEvent) => {
      const current = project(event);
      session.current = null;
      setCandidateId(null); setMembershipPreview(null);
      if (!current) return;
      if (!current.dx && !current.dy) { setPositions({}); return; }
      const command: FrameCommand = current.mode === 'resize'
        ? { commandId: crypto.randomUUID(), projectId: current.state.project.id, type: 'frame.resize', expected: current.frame.versionId,
          placement: { expected: captureSpatial(current.state, { rect: current.rect!, frameId: current.frame.id }) }, payload: { id: current.frame.id, pose: current.rect! } }
        : moveFrameCommand(current.state, current.frame, current.dx, current.dy, latest.current.point({ x: event.clientX, y: event.clientY }));
      latest.current.execute(command, () => setPositions({}));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, []);
  return {
    positions, candidateId, membershipPreview,
    keyboardResize(frame: CanvasFrame, corner: string, key: string) {
      if (latest.current.blocked || !latest.current.state || session.current) return;
      if (key === 'Escape') { keyboard.current = null; setPositions({}); setMembershipPreview(null); return; }
      if (key === 'Enter') {
        const current = keyboard.current; keyboard.current = null; setMembershipPreview(null);
        if (current) latest.current.execute({ commandId: crypto.randomUUID(), projectId: current.state.project.id, type: 'frame.resize',
          expected: current.frame.versionId, placement: { expected: captureSpatial(current.state, { rect: current.rect, frameId: current.frame.id }) }, payload: { id: current.frame.id, pose: current.rect } }, () => setPositions({}));
        return;
      }
      const current = keyboard.current ?? { state: latest.current.state, frame, corner, rect: frame.pose };
      const dx = key === 'ArrowLeft' ? -10 : key === 'ArrowRight' ? 10 : 0;
      const dy = key === 'ArrowUp' ? -10 : key === 'ArrowDown' ? 10 : 0;
      current.rect = resizedFrameRect(current.rect, corner, dx, dy); keyboard.current = current;
      setPositions({ [frame.id]: current.rect }); setMembershipPreview(frameResizePlan(current.state, frame.id, current.rect));
    },
    hasKeyboardResize: () => !!keyboard.current,
    startResize(event: ReactPointerEvent<HTMLElement>, frame: CanvasFrame, corner: string) {
      if (event.button !== 0 || latest.current.blocked || !latest.current.state || session.current) return;
      event.preventDefault(); event.stopPropagation();
      session.current = { state: latest.current.state, frame, start: latest.current.point({ x: event.clientX, y: event.clientY }), dx: 0, dy: 0, mode: 'resize', corner };
    },
    start(event: ReactPointerEvent<HTMLElement>, frame: CanvasFrame) {
      if (event.button !== 0 || latest.current.blocked || !latest.current.state || session.current) return;
      event.preventDefault(); event.stopPropagation();
      moved.current.delete(frame.id);
      session.current = { state: latest.current.state, frame,
        start: latest.current.point({ x: event.clientX, y: event.clientY }), dx: 0, dy: 0, mode: 'move' };
    },
    consumeClick(id: string) {
      if (!moved.current.has(id)) return false;
      moved.current.delete(id); return true;
    },
    hasGesture: () => !!session.current || !!keyboard.current,
    cancel() { keyboard.current = null; session.current = null; setPositions({}); setCandidateId(null); setMembershipPreview(null); },
  };
}

export function CanvasFrames({ state, preview, selectedId, choose, focusId, onFocusRestored, blocked, execute, move, dropCandidateId, drawMemberIds = [] }: {
  state: ProjectState; preview: FrameRect | null; dropCandidateId?: string | null; drawMemberIds?: string[]; selectedId: string | null; choose: (id: string | null) => void; blocked: boolean; execute: Execute;
  move: ReturnType<typeof useFrameMove>; focusId: string | null; onFocusRestored: (id: string) => void;
}) {
  const [editing, setEditing] = useState<{ projectId: string; id: string; versionId: string } | null>(null);
  const [name, setName] = useState('');
  const [background, setBackground] = useState('');
  const [composing, setComposing] = useState(false);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const handles = useRef<Record<string, HTMLButtonElement | null>>({});
  const restoreHandleFocus = useRef<string | null>(null);
  useEffect(() => {
    if (blocked || !restoreHandleFocus.current) return;
    const target = handles.current[restoreHandleFocus.current];
    restoreHandleFocus.current = null;
    target?.focus({ preventScroll: true });
  }, [blocked, state.project.revision]);
  const membershipPreview = move.membershipPreview ?? (drawMemberIds.length ? { attach: drawMemberIds, release: [] } : null);
  const edited = state.frames?.find(frame => frame.id === editing?.id);
  useEffect(() => {
    if (!focusId) return;
    triggers.current[focusId]?.focus({ preventScroll: true });
    onFocusRestored(focusId);
  }, [focusId, onFocusRestored]);
  function begin(frame: CanvasFrame) {
    choose(frame.id);
    setEditing({ projectId: state.project.id, id: frame.id, versionId: frame.versionId }); setName(frame.name); setBackground(frame.background ?? '');
  }
  function save() {
    const session = editing;
    if (!session || blocked || composing || !name.trim() || background && !/^#[0-9a-f]{6}$/i.test(background)) return;
    execute({ commandId: crypto.randomUUID(), projectId: session.projectId, type: 'frame.edit', expected: session.versionId,
      payload: { id: session.id, name, background: background || null } }, () => {
        requestAnimationFrame(() => triggers.current[session.id]?.focus({ preventScroll: true }));
      }, () => setEditing(current => current === session ? null : current));
  }
  return <>
    {(state.frames ?? []).map(frame => {
      const position = move.positions[frame.id] ?? frame.pose;
      return <Fragment key={frame.id}><div role="group" aria-label={`分区：${frame.name}`}
        className="canvas-frame" data-frame-id={frame.id} data-drop-candidate={(move.candidateId ?? dropCandidateId) === frame.id} data-selected={selectedId === frame.id} style={{ left: position.x, top: position.y,
          width: move.positions[frame.id]?.width ?? frame.pose.width, height: move.positions[frame.id]?.height ?? frame.pose.height, background: frame.background ?? 'transparent' }}>
        {edited?.id === frame.id ? <form className="canvas-frame-editor nodrag nopan" onSubmit={event => { event.preventDefault(); save(); }}>
          <textarea aria-label="分区名称" rows={1} maxLength={240} autoFocus value={name} readOnly={blocked}
            onChange={event => setName(event.target.value)}
            onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
            onKeyDown={event => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Enter' && !event.shiftKey || event.key === 'Escape') { event.preventDefault(); save(); }
            }} />
          <input aria-label="分区背景" type="text" placeholder="透明" value={background} readOnly={blocked}
            onChange={event => setBackground(event.target.value)} onKeyDown={event => event.stopPropagation()} />
          <button type="button" disabled={blocked}
            onClick={() => {
              const session = editing;
              execute(deleteFrameCommand(state, frame), () => choose(null),
                () => setEditing(current => current === session ? null : current));
            }}>删除分区</button>
          <button type="submit" disabled={blocked || !name.trim() || !!background && !/^#[0-9a-f]{6}$/i.test(background)}>保存分区</button>
        </form> : <div className="canvas-frame-header">
          <button ref={element => { triggers.current[frame.id] = element; }} type="button"
            className="canvas-frame-name nodrag nopan" aria-pressed={selectedId === frame.id} disabled={blocked}
            onPointerDown={event => { choose(frame.id); move.start(event, frame); }}
            onClick={event => { if (!move.consumeClick(frame.id)) { choose(frame.id); event.currentTarget.focus({ preventScroll: true }); } }}
            onDoubleClick={() => begin(frame)}>{frame.name}</button>
          {selectedId === frame.id && <div className="canvas-frame-actions nodrag nopan" role="toolbar" aria-label="分区操作">
            <button type="button" disabled={blocked} onClick={() => begin(frame)}>重命名分区</button>
            <button type="button" disabled={blocked} onClick={() => execute(deleteFrameCommand(state, frame), () => choose(null))}>删除分区</button>
          </div>}
        </div>}
      </div>
      {selectedId === frame.id && <div className="frame-resize-overlay" style={{ left: position.x, top: position.y,
        width: move.positions[frame.id]?.width ?? frame.pose.width, height: move.positions[frame.id]?.height ?? frame.pose.height }}>
        {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map(corner =>
          <button key={corner} ref={element => { handles.current[`${frame.id}:${corner}`] = element; }} type="button" className="frame-resize-handle nodrag nopan" data-corner={corner}
            aria-label={`调整分区范围：${frameHandleNames[corner]}`} title="方向键调整，Enter 保存，Esc 取消" disabled={blocked}
            onPointerDown={event => move.startResize(event, frame, corner)}
            onBlur={() => { if (move.hasKeyboardResize()) move.cancel(); }}
            onKeyDown={event => {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) {
                event.preventDefault(); event.stopPropagation();
                if (event.key === 'Enter' && move.hasKeyboardResize()) restoreHandleFocus.current = `${frame.id}:${corner}`;
                move.keyboardResize(frame, corner, event.key);
              }
            }} />)}
      </div>}
      </Fragment>;
    })}
    {membershipPreview && [...membershipPreview.attach, ...membershipPreview.release].map(id => {
      const item = [...state.cards, ...(state.texts ?? []), ...(state.shapes ?? []), ...(state.images ?? []), ...(state.strokes ?? [])].find(v => v.item.id === id);
      const rect = item?.item.pose ?? state.groups?.find(v => v.itemId === id)?.bounds ?? state.frames?.find(v => v.id === id)?.pose;
      return rect ? <div key={id} aria-hidden="true" className="frame-member-preview" data-releasing={membershipPreview!.release.includes(id)}
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} /> : null;
    })}
    {preview && <div aria-hidden="true" className="canvas-frame-preview" style={{ left: preview.x, top: preview.y,
      width: preview.width, height: preview.height }} />}
  </>;
}
