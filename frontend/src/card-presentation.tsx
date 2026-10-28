import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Card } from "./api";
import { bodyText } from "../../backend/src/mapping/body-text";

// Current Body adapter: full text blocks, with their boundaries. Future rich
// blocks must supply their own explicit projection here, never a second summary
// or the editor's folded/visible DOM. No HTML is interpreted as markup.
export function bodyPreviewText(body: Card["body"]) {
  return bodyText(body);
}

export function measureCardPresentation(element: HTMLElement) {
  const title = element.querySelector<HTMLElement>('.title-button,.card-title');
  if (!title) throw new Error('卡片标题尚未就绪');
  const tagHeight = element.querySelector<HTMLElement>('.card-visible-tags')?.offsetHeight ?? 0;
  const style = getComputedStyle(element);
  const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const preview = element.querySelector<HTMLElement>('.preview');
  const lineHeight = preview ? parseFloat(getComputedStyle(preview).lineHeight) : 22;
  return { necessaryHeight: Math.ceil(title.offsetHeight + tagHeight + borders),
    lines: Math.max(0, Math.floor((element.clientHeight - title.offsetHeight - tagHeight - 24) / lineHeight)) };
}

// A future tag owner renders its single visible row in .card-visible-tags;
// measurement consumes that actual row, never the full tag count or demo data.
export function useCardPresentation(
  anchor: RefObject<HTMLElement | null>,
  card: Card,
  onMeasure: (card: Card, necessaryHeight: number) => void,
  enabled: boolean,
) {
  const [lines, setLines] = useState(0);
  const callback = useRef(onMeasure);
  callback.current = onMeasure;
  useLayoutEffect(() => {
    const element = anchor.current;
    if (!element) return;
    let active = true;
    function measure() {
      if (!active) return;
      const { necessaryHeight, lines: count } = measureCardPresentation(element!);
      setLines((previous) => (previous === count ? previous : count));
      if (enabled) callback.current(card, necessaryHeight);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const title = element.querySelector(".title-button,.card-title");
    if (title) observer.observe(title);
    const tags = element.querySelector(".card-visible-tags");
    if (tags) observer.observe(tags);
    document.fonts.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [card, anchor, enabled]);
  return lines;
}
