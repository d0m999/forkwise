import { useLayoutEffect, useRef, type PointerEvent } from 'react';
import type { CanvasConnector as Connector, ConnectorEndpoint } from '../../backend/src/mapping/connector-contracts';
import type { ConnectorDraft } from './connector-create';
import { freeLineGeometry, type ConnectorPoint } from './connector-geometry';
import type { ConnectorTarget } from './connector-targets';

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

export function CanvasConnector({ value, selected, choose, resolve, drag, focus, focused }: {
  value: Connector; selected: boolean; choose: () => void; resolve: (endpoint: ConnectorEndpoint) => ConnectorPoint | null;
  drag: (event: PointerEvent<SVGSVGElement>) => void;
  focus: boolean; focused: () => void;
}) {
  const element = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => { if (focus && selected && element.current) { element.current.focus(); focused(); } }, [focus, selected, focused]);
  const start = resolve(value.start), end = resolve(value.end);
  if (!start || !end) return null;
  const line = freeLineGeometry(start, end, value.path);
  return <svg ref={element} role="button" aria-label="普通连线" aria-pressed={selected} tabIndex={0}
    className="canvas-connector nodrag nopan" width={line.width} height={line.height} style={{ left: line.x, top: line.y }}
    onPointerDown={drag} onClick={event => { event.stopPropagation(); choose(); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose(); }
    }}>
    <path d={line.path} />
  </svg>;
}

export function ConnectorPreview({ draft }: { draft: ConnectorDraft | null }) {
  if (!draft) return null;
  const line = freeLineGeometry(draft.start, draft.end);
  return <svg role="img" aria-label="连线预览" className="canvas-connector connector-preview"
    width={line.width} height={line.height} style={{ left: line.x, top: line.y }}>
    <path d={line.path} />
  </svg>;
}
