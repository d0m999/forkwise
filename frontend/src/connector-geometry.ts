import type { CanvasConnector } from '../../backend/src/mapping/connector-contracts';

export type ConnectorPoint = { x: number; y: number };

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
