import type { Card } from "./api";
export type Position = { x: number; y: number };
export type Guide = {
  axis: "x" | "y";
  position: number;
  start: number;
  end: number;
};
export function bounds(cards: Card[]) {
  const p = cards.map((c) => c.item.pose);
  const x = Math.min(...p.map((a) => a.x)),
    y = Math.min(...p.map((a) => a.y));
  return {
    x,
    y,
    width: Math.max(...p.map((a) => a.x + a.width)) - x,
    height: Math.max(...p.map((a) => a.y + a.height)) - y,
  };
}
// Alignment translates the entire selection box. It never places individual
// members, rearranges neighbours, or creates a persisted group or relationship.
export function alignMove(
  cards: Card[],
  anchor: Card,
  position: Position,
  others: Card[],
  zoom: number,
) {
  const b = bounds(cards),
    ids = new Set(cards.map((c) => c.id));
  const dx = position.x - anchor.item.pose.x,
    dy = position.y - anchor.item.pose.y;
  const moving = { ...b, x: b.x + dx, y: b.y + dy };
  const result = { ...position };
  const guides: Guide[] = [];
  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? "width" : "height";
    const cross = axis === "x" ? "y" : "x",
      crossSize = axis === "x" ? "height" : "width";
    let best = 6 / zoom,
      offset = 0,
      guide: Guide | null = null;
    for (const c of others) {
      if (ids.has(c.id)) continue;
      const p = c.item.pose;
      for (const target of [p[axis], p[axis] + p[size] / 2, p[axis] + p[size]])
        for (const source of [
          moving[axis],
          moving[axis] + moving[size] / 2,
          moving[axis] + moving[size],
        ]) {
          const difference = target - source;
          if (Math.abs(difference) < best) {
            best = Math.abs(difference);
            offset = difference;
            guide = {
              axis,
              position: target,
              start: Math.min(moving[cross], p[cross]) - 20,
              end:
                Math.max(
                  moving[cross] + moving[crossSize],
                  p[cross] + p[crossSize],
                ) + 20,
            };
          }
        }
    }
    result[axis] += offset;
    if (guide) guides.push(guide);
  }
  return { position: result, guides };
}
