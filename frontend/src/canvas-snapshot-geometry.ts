export const COPY_OFFSET = 24;

export type Box = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type PasteSequence = { clipboard: string; drop: string; viewport: string; count: number };

export function boundsCenter(boxes: Box[], points: Point[]): Point {
  const left = Math.min(...boxes.map(box => box.x), ...points.map(point => point.x));
  const right = Math.max(...boxes.map(box => box.x + box.width), ...points.map(point => point.x));
  const top = Math.min(...boxes.map(box => box.y), ...points.map(point => point.y));
  const bottom = Math.max(...boxes.map(box => box.y + box.height), ...points.map(point => point.y));
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

export function pasteTranslation(center: Point, drop: Point, index: number): Point {
  return { x: drop.x - center.x + index * COPY_OFFSET, y: drop.y - center.y + index * COPY_OFFSET };
}

// Exact keys only. Pointer jitter and intervening edits stay undecided, so neither adds a reset rule.
export function nextPaste(previous: PasteSequence | null, keys: Omit<PasteSequence, 'count'>): { index: number; sequence: PasteSequence } {
  const same = !!previous && previous.clipboard === keys.clipboard && previous.drop === keys.drop && previous.viewport === keys.viewport;
  const index = same ? previous.count : 0;
  return { index, sequence: { ...keys, count: index + 1 } };
}
