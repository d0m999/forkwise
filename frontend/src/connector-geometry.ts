import type { CanvasConnector } from '../../backend/src/mapping/connector-contracts';

export type ConnectorPoint = { x: number; y: number };

// Use the rendered SVG curve, so elbows and Béziers share the same distance
// fraction for display, dragging, persistence and later geometry updates.
export function connectorPathPosition(path: SVGPathElement, client: ConnectorPoint): number | null {
  const matrix = path.getScreenCTM(), length = path.getTotalLength();
  if (!matrix || !length) return null;
  const point = new DOMPoint(client.x, client.y).matrixTransform(matrix.inverse());
  const distance = (position: number) => { const q = path.getPointAtLength(position * length); return (q.x - point.x) ** 2 + (q.y - point.y) ** 2; };
  let best = 0;
  for (let i = 1; i <= 64; i++) if (distance(i / 64) < distance(best)) best = i / 64;
  let low = Math.max(0, best - 1 / 64), high = Math.min(1, best + 1 / 64);
  for (let i = 0; i < 24; i++) {
    const a = low + (high - low) / 3, b = high - (high - low) / 3;
    if (distance(a) <= distance(b)) high = b; else low = a;
  }
  return (low + high) / 2;
}

export function freeLineGeometry(start: ConnectorPoint, end: ConnectorPoint, mode: CanvasConnector['path'] = 'straight') {
  const padding = 8, x = Math.min(start.x, end.x) - padding, y = Math.min(start.y, end.y) - padding;
  const sx = start.x - x, sy = start.y - y, ex = end.x - x, ey = end.y - y, middle = (sx + ex) / 2;
  const path = mode === 'elbow' ? `M${sx} ${sy} H${middle} V${ey} H${ex}`
    : mode === 'curve' ? `M${sx} ${sy} C${middle} ${sy} ${middle} ${ey} ${ex} ${ey}`
    : `M${sx} ${sy} L${ex} ${ey}`;
  return {
    x, y, width: Math.abs(end.x - start.x) + padding * 2, height: Math.abs(end.y - start.y) + padding * 2,
    path,
  };
}
