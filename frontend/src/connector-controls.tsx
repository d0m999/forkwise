import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { CanvasConnector, ConnectorEndpoint, ConnectorLabel, ConnectorStyle } from '../../backend/src/mapping/connector-contracts';
import { ConnectorAppearance } from './connector-appearance';
import type { ConnectorPoint } from './connector-geometry';

export function ConnectorHandles({ value, resolve, blocked, start, activate }: {
  value: CanvasConnector; resolve: (endpoint: ConnectorEndpoint) => ConnectorPoint | null; blocked: boolean;
  start: (endpoint: 'start' | 'end', event: PointerEvent<HTMLButtonElement>) => void;
  activate: (endpoint: 'start' | 'end', element: HTMLElement) => void;
}) {
  return <>{(['start', 'end'] as const).map(endpoint => {
    const point = resolve(value[endpoint]);
    return point && <button key={endpoint} type="button" aria-label={endpoint === 'start' ? '连线起点' : '连线终点'}
      className="connector-endpoint nodrag nopan" disabled={blocked} style={{ left: point.x, top: point.y }}
      onPointerDown={event => start(endpoint, event)}
      onClick={event => { if (event.detail === 0) activate(endpoint, event.currentTarget); }}
      onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) { event.preventDefault(); event.stopPropagation(); } }} />;
  })}</>;
}

export function ConnectorPathControls({ value, blocked, choose, remove, move, appearance, reverse, editLabel, labelStyle }: {
  value: CanvasConnector; blocked: boolean; choose: (path: CanvasConnector['path'], origin: HTMLButtonElement) => void; remove: () => void;
  appearance: (patch: Partial<ConnectorStyle>) => void;
  reverse: () => void;
  editLabel: (origin: HTMLButtonElement) => void;
  labelStyle: (patch: Partial<Pick<ConnectorLabel, 'fontSize' | 'color' | 'bold' | 'position'>>) => void;
  move: { active: boolean; blocked: boolean; composing: () => boolean; start: (origin: HTMLElement) => void;
    preview: (dx: number, dy: number) => void; finish: () => void; cancel: () => void };
}) {
  const instructions = useId();
  const positionInstructions = useId(), positionInput = useRef<HTMLInputElement>(null);
  const [labelPosition, setLabelPosition] = useState(String((value.label?.position ?? 0.5) * 100));
  useEffect(() => { setLabelPosition(String((value.label?.position ?? 0.5) * 100)); }, [value.id, value.label?.position]);
  return <div className="creation-tools connector-tools" role="group" aria-label="连线路径" style={{ whiteSpace: 'normal', flexWrap: 'wrap' }}>
    <ConnectorAppearance value={value.style} blocked={blocked} change={appearance} />
    <button type="button" disabled={blocked} onClick={reverse}>反转方向</button>
    <button type="button" disabled={blocked} onClick={event => editLabel(event.currentTarget)}>{value.label ? '编辑文字' : '添加文字'}</button>
    {value.label && <>
      <label>标签字号<select disabled={blocked} value={value.label.fontSize} onChange={event => labelStyle({ fontSize: Number(event.target.value) })}>
        {[...new Set([12, 16, 24, 32, value.label.fontSize])].sort((a, b) => a - b).map(size => <option key={size} value={size}>{size} px</option>)}
      </select></label>
      <label>标签颜色<input type="color" disabled={blocked} value={value.label.color} onChange={event => labelStyle({ color: event.target.value })} /></label>
      <button type="button" disabled={blocked} aria-pressed={value.label.bold} onClick={() => labelStyle({ bold: !value.label!.bold })}>标签粗体</button>
      <form className="connector-label-position" onSubmit={event => {
        event.preventDefault();
        if (blocked) return;
        positionInput.current?.focus();
        labelStyle({ position: Number(labelPosition) / 100 });
      }}>
        <label>标签位置（%）<input ref={positionInput} type="number" min="0" max="100" step="any" required readOnly={blocked}
          aria-describedby={positionInstructions} value={labelPosition} onChange={event => setLabelPosition(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return; }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setLabelPosition(String(value.label!.position * 100)); }
          }} /></label>
        <button type="submit" disabled={blocked}>应用标签位置</button>
        <p id={positionInstructions}>0% 为起点，100% 为终点；Enter 应用，Esc 取消</p>
      </form>
    </>}
    {([['straight', '直线'], ['elbow', '折线'], ['curve', '曲线']] as const).map(([path, name]) =>
      <button key={path} type="button" aria-pressed={value.path === path} disabled={blocked} onClick={event => choose(path, event.currentTarget)}>{name}</button>)}
    <button type="button" disabled={blocked} onClick={remove}>删除连线</button>
    <button type="button" disabled={move.blocked || (value.start.kind === 'bound' && value.end.kind === 'bound')} aria-describedby={move.active ? instructions : undefined}
      onClick={event => { if (!move.active && !move.composing()) move.start(event.currentTarget); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || move.composing()) { event.preventDefault(); event.stopPropagation(); return; }
        if (!move.active) return;
        const steps: Record<string, readonly [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };
        const delta = steps[event.key];
        if (!delta && event.key !== 'Enter' && event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation();
        if (move.blocked) return;
        if (delta) move.preview(delta[0], delta[1]); else if (event.key === 'Enter') move.finish(); else move.cancel();
      }}>移动连线</button>
    {move.active && <p id={instructions}>方向键移动连线，Enter 确认，Escape 取消</p>}
  </div>;
}

export function ConnectorCreateControls({ active, focusFree, blocked, composing, start, preview, choose, cancel }: {
  active: boolean; focusFree: boolean; blocked: boolean; composing: () => boolean; start: (origin: HTMLElement) => void;
  preview: (dx?: number, dy?: number) => void; choose: () => void; cancel: () => void;
}) {
  const free = useRef<HTMLButtonElement>(null), instructions = useId();
  useLayoutEffect(() => { if (active && focusFree) free.current?.focus(); }, [active, focusFree]);
  return <div className="creation-tools connector-tools" role="group" aria-label="键盘创建连线" style={{ whiteSpace: 'normal', flexWrap: 'wrap' }}>
    <button type="button" disabled={blocked} onClick={event => start(event.currentTarget)}
      onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229 || composing()) { event.preventDefault(); event.stopPropagation(); } }}>从空白处开始连线</button>
    {active && <><button ref={free} type="button" aria-label="连线自由终点" aria-describedby={instructions} disabled={blocked}
      onFocus={() => preview()} onClick={event => { if (event.detail === 0 && !composing()) choose(); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || composing()) { event.preventDefault(); event.stopPropagation(); return; }
        const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
        if (!delta && event.key !== 'Enter' && event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation();
        if (blocked) return;
        if (delta) preview(delta[0], delta[1]); else if (event.key === 'Enter') choose(); else cancel();
      }}>自由终点</button><p id={instructions}>方向键调整自由终点，Enter 确认，Escape 取消</p></>}
  </div>;
}
export function ConnectorEndpointControls({ endpoint, blocked, composing, preview, choose, cancel }: {
  endpoint: 'start' | 'end'; blocked: boolean; composing: () => boolean;
  preview: (dx?: number, dy?: number) => void; choose: () => void; cancel: () => void;
}) {
  const instructions = useId();
  return <div className="creation-tools connector-tools" role="group" aria-label="键盘编辑连线端点" style={{ whiteSpace: 'normal', flexWrap: 'wrap' }}>
    <button type="button" aria-label={endpoint === 'start' ? '连线自由起点' : '连线自由终点'} aria-describedby={instructions} disabled={blocked}
      onFocus={() => preview()} onClick={event => { if (event.detail === 0 && !composing()) choose(); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || composing()) { event.preventDefault(); event.stopPropagation(); return; }
        const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
        if (!delta && event.key !== 'Enter' && event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation();
        if (blocked) return;
        if (delta) preview(delta[0], delta[1]); else if (event.key === 'Enter') choose(); else cancel();
      }}>{endpoint === 'start' ? '自由起点' : '自由终点'}</button>
    <p id={instructions}>方向键调整自由端，Enter 确认，Escape 取消</p>
  </div>;
}
