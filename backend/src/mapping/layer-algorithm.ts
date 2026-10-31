export type LayerOperation = 'front' | 'back' | 'forward' | 'backward';
export type LayerNode = {
  id: string;
  pose: { x: number; y: number; width: number; height: number };
};

function overlaps(a: LayerNode['pose'], b: LayerNode['pose']) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function forwardOrder(values: LayerNode[], selected: Set<string>) {
  const n = values.length,
    barrier = new Map<string, number>();
  let furthest = -1;
  for (let i = 0; i < n; i++) {
    const value = values[i]!;
    if (!selected.has(value.id)) continue;
    let target = -1;
    for (let j = i + 1; j < n; j++) {
      const other = values[j]!;
      if (selected.has(other.id)) continue;
      if (overlaps(value.pose, other.pose)) {
        target = j;
        break;
      }
    }
    let level = i <= furthest ? furthest : -1;
    if (target >= 0) {
      furthest = Math.max(furthest, target);
      level = Math.max(level, target);
    }
    if (level > i) barrier.set(value.id, level);
  }
  if (!barrier.size) return values.map(value => value.id);
  const out: string[] = [],
    pending: string[] = [];
  for (let i = 0; i < n; i++) {
    const value = values[i]!;
    if (barrier.has(value.id)) {
      pending.push(value.id);
      continue;
    }
    out.push(value.id);
    while (pending.length && barrier.get(pending[0]!)! <= i) out.push(pending.shift()!);
  }
  out.push(...pending);
  return out;
}

function backwardOrder(values: LayerNode[], selected: Set<string>) {
  const n = values.length,
    barrier = new Map<string, number>();
  let nearest = n;
  for (let i = n - 1; i >= 0; i--) {
    const value = values[i]!;
    if (!selected.has(value.id)) continue;
    let target = -1;
    for (let j = i - 1; j >= 0; j--) {
      const other = values[j]!;
      if (selected.has(other.id)) continue;
      if (overlaps(value.pose, other.pose)) {
        target = j;
        break;
      }
    }
    let level = i >= nearest ? nearest : n;
    if (target >= 0) {
      nearest = Math.min(nearest, target);
      level = Math.min(level, target);
    }
    if (level < i) barrier.set(value.id, level);
  }
  if (!barrier.size) return values.map(value => value.id);
  const topDown: string[] = [],
    pending: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const value = values[i]!;
    if (barrier.has(value.id)) {
      pending.push(value.id);
      continue;
    }
    topDown.push(value.id);
    while (pending.length && barrier.get(pending[0]!)! >= i) topDown.push(pending.shift()!);
  }
  topDown.push(...pending);
  return topDown.reverse();
}

export function nextLayerOrder(
  values: LayerNode[],
  selected: Set<string>,
  operation: LayerOperation,
) {
  if (operation === 'front')
    return [...values.filter(value => !selected.has(value.id)), ...values.filter(value => selected.has(value.id))].map(
      value => value.id,
    );
  if (operation === 'back')
    return [...values.filter(value => selected.has(value.id)), ...values.filter(value => !selected.has(value.id))].map(
      value => value.id,
    );
  return operation === 'forward' ? forwardOrder(values, selected) : backwardOrder(values, selected);
}
