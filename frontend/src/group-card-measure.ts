import type { Card } from './api';
import { measureCardPresentation } from './card-presentation';

// A transient copy of the actual rendered card preserves title, visible tags,
// typography and borders. It never participates in focus, selection or saving.
export function captureGroupCards(cards: Card[]) {
  const container = document.createElement('div');
  container.dataset.groupMeasurement = 'cards';
  container.inert = true;
  container.setAttribute('aria-hidden', 'true');
  Object.assign(container.style, { position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', pointerEvents: 'none' });
  const copies = cards.map(card => {
    const original = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(card.item.id)}"] .thought-card`);
    if (!original) throw new Error('卡片尚未完成显示，请稍后调整组合');
    const element = original.cloneNode(true) as HTMLElement;
    Object.assign(element.style, { width: `${card.item.pose.width}px`, height: `${card.item.pose.height}px` });
    container.append(element);
    return { card, element };
  });
  document.body.append(container);
  function measure(scale: number) {
    const values: Record<string, { forWidth: number; necessaryHeight: number }> = {};
    for (const { card, element } of copies) {
      const forWidth = card.item.pose.width * scale;
      element.style.width = `${forWidth}px`;
      element.style.height = `${card.item.pose.height * scale}px`;
      values[card.item.id] = { forWidth, necessaryHeight: measureCardPresentation(element).necessaryHeight };
    }
    return values;
  }
  const fits = (scale: number, values: ReturnType<typeof measure>) => cards.every(card => card.item.pose.height * scale >= values[card.item.id]!.necessaryHeight);
  const initialStarted = performance.now();
  let initialElapsed = 0;
  try {
    const initial = measure(1);
    initialElapsed = performance.now() - initialStarted;
    if (initialElapsed > 500) throw new Error('组合尺寸测量超时，本次未保存，请重新调整');
    if (!fits(1, initial)) throw new Error('卡片布局尚未稳定，请等待保存后再调整组合');
  } catch (error) { container.remove(); throw error; }
  return {
    dispose: () => container.remove(),
    solve(requested: number, minimum: number, extent: number, zoom: number) {
      // Count source measurement work, excluding the user's time dragging.
      const started = performance.now() - initialElapsed;
      let count = 1;
      const sample = (scale: number) => {
        if (++count > 24 || performance.now() - started > 500) throw new Error('组合尺寸测量超时，本次未保存，请重新调整');
        const values = measure(scale);
        if (performance.now() - started > 500) throw new Error('组合尺寸测量超时，本次未保存，请重新调整');
        return values;
      };
      let scale = Math.max(minimum, requested), values = sample(scale);
      if (!fits(scale, values)) {
        let lower = scale, upper = 1, feasible = sample(1);
        if (scale >= 1 || !fits(1, feasible)) throw new Error('卡片测量不稳定，本次未保存，请重新调整');
        while ((upper - lower) * extent * zoom > 0.5) {
          const middle = (upper + lower) / 2, measured = sample(middle);
          if (fits(middle, measured)) { upper = middle; feasible = measured; }
          else lower = middle;
        }
        scale = upper; values = feasible;
      }
      const final = sample(scale);
      if (!fits(scale, final) || JSON.stringify(final) !== JSON.stringify(values)) throw new Error('卡片测量不稳定，本次未保存，请重新调整');
      return { scale, cards: final, measurementCount: count, remainingMilliseconds: 500 - (performance.now() - started) };
    },
  };
}
