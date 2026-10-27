import { useId, useLayoutEffect, useRef, type PointerEvent } from 'react';
import { DEFAULT_CONNECTOR_STYLE, type CanvasConnector as Connector, type ConnectorEndpoint, type ConnectorStyle } from '../../backend/src/mapping/connector-contracts';
import type { ConnectorDraft } from './connector-create';
import { freeLineGeometry, type ConnectorPoint } from './connector-geometry';
import type { ConnectorTarget } from './connector-targets';
import { ConnectorLabel, type LabelEditor } from './connector-label';

export function ConnectorEntries({ values, choose, preview }: { values: ConnectorTarget[];
  choose: (value: ConnectorTarget, element: HTMLElement) => void; preview: (value: ConnectorTarget) => void }) {
  const names = { top: '上', right: '右', bottom: '下', left: '左' };
  return <>{values.map(value => <button key={JSON.stringify([value.itemId, value.side])} type="button"
    className="connector-entry nodrag nopan" aria-label={value.label + ' 连线起点：' + names[value.side]}
    data-connector-item={value.itemId} data-connector-side={value.side}
    onFocus={() => preview(value)} onClick={event => { if (event.detail === 0) choose(value, event.currentTarget); }}
    onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) { event.preventDefault(); event.stopPropagation(); } }}
    style={{ left: value.point.x, top: value.point.y }} />)}</>;
}

export function CanvasConnector({ value, selected, choose, resolve, drag, focus, focused, labelEditor }: {
  value: Connector; selected: boolean; choose: (extend: boolean) => void; resolve: (endpoint: ConnectorEndpoint) => ConnectorPoint | null;
  drag: (event: PointerEvent<SVGSVGElement>) => void;
  focus: boolean; focused: () => void;
  labelEditor: LabelEditor;
}) {
  const element = useRef<SVGSVGElement>(null);
  const path = useRef<SVGPathElement>(null);
  const markerId = useId();
  useLayoutEffect(() => { if (focus && selected && element.current) { element.current.focus(); focused(); } }, [focus, selected, focused]);
  const start = resolve(value.start), end = resolve(value.end);
  if (!start || !end) return null;
  const line = freeLineGeometry(start, end, value.path);
  const style = value.style ?? DEFAULT_CONNECTOR_STYLE;
  function marker(side: 'start' | 'end', kind: ConnectorStyle['startMarker']) {
    if (kind === 'none') return null;
    return <marker id={`${markerId}-${side}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
      {kind === 'open-arrow' ? <polyline points="1,1 9,5 1,9" fill="none" stroke={style.color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        : kind === 'dot' ? <circle cx="5" cy="5" r="4" fill={style.color} />
        : <polygon points={kind === 'triangle' ? '1,1 9,5 1,9' : '1,5 5,1 9,5 5,9'} fill={style.color} />}
    </marker>;
  }
  return <><svg ref={element} role="button" aria-label="普通连线" aria-pressed={selected} tabIndex={0} data-connector-id={value.id}
    className="canvas-connector nodrag nopan" width={line.width} height={line.height} style={{ left: line.x, top: line.y }}
    onPointerDown={drag} onClick={event => { event.stopPropagation(); choose(event.shiftKey); }}
    onDoubleClick={event => { event.stopPropagation(); if (!value.label) labelEditor.begin(event.currentTarget); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose(event.shiftKey); }
    }}>
    <defs>{marker('start', style.startMarker)}{marker('end', style.endMarker)}</defs>
    <path ref={path} d={line.path} style={{ stroke: style.color, strokeWidth: style.width, strokeDasharray: style.dash === 'dashed' ? `${style.width * 2} ${style.width * 2}` : undefined }}
      markerStart={style.startMarker === 'none' ? undefined : `url(#${markerId}-start)`}
      markerEnd={style.endMarker === 'none' ? undefined : `url(#${markerId}-end)`} />
  </svg><ConnectorLabel value={value} path={path} origin={line} geometry={line.path} editor={labelEditor} choose={choose} /></>;
}

export function ConnectorPreview({ draft }: { draft: ConnectorDraft | null }) {
  if (!draft) return null;
  const line = freeLineGeometry(draft.start, draft.end);
  return <svg role="img" aria-label="连线预览" className="canvas-connector connector-preview"
    width={line.width} height={line.height} style={{ left: line.x, top: line.y }}>
    <path d={line.path} />
  </svg>;
}
