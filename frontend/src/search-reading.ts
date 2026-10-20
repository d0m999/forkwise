import type { SearchResult } from "../../backend/src/mapping/search-contracts";
import { textPoint } from "./reading-anchor";
import { blockText } from "./general-block-dom";

export type SearchCard = SearchResult["results"][number];
export type SearchReading = {
  result: SearchCard;
  text: string;
  hit: number;
  preserveViewport?: boolean;
};

export function searchHitIdentity(result: SearchCard, index: number) {
  const hit = result.bodyHits[index];
  if (!hit) return null;
  const segment = result.segments[hit.segment];
  return JSON.stringify([
    hit.blockId,
    segment?.row,
    segment?.column,
    hit.start,
    hit.end,
  ]);
}

// Resolve original matcher offsets against the same body version, preserving
// table-cell and image-caption boundaries. Highlighting never edits the DOM.
export function searchRanges(
  root: HTMLElement,
  result: SearchCard,
): (Range | null)[] {
  return result.bodyHits.map((hit) => {
    const segment = result.segments[hit.segment];
    const block = Array.from(
      root.querySelectorAll<HTMLElement>("[data-block-id]"),
    ).find((node) => node.dataset.blockId === hit.blockId);
    if (!block || !segment) return null;
    const text =
      segment.row === undefined
        ? (block.querySelector(".image-caption") ?? block)
        : block.querySelector(`[data-cell="${segment.row},${segment.column}"]`);
    if (!(text instanceof HTMLElement) || blockText(text) !== segment.text)
      return null;
    const start = textPoint(text, hit.start),
      end = textPoint(text, hit.end);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  });
}
export function highlightSearch(
  root: HTMLElement,
  result: SearchCard,
  hit: number,
  scope: "preview" | "board",
) {
  const ranges = searchRanges(root, result);
  CSS.highlights.set(
    `search-${scope}`,
    new Highlight(...ranges.filter((range): range is Range => !!range)),
  );
  CSS.highlights.set(
    `search-${scope}-current`,
    new Highlight(...(ranges[hit] ? [ranges[hit]!] : [])),
  );
  return () => {
    CSS.highlights.delete(`search-${scope}`);
    CSS.highlights.delete(`search-${scope}-current`);
  };
}
export function scrollToSearchHit(
  root: HTMLElement,
  scroller: HTMLElement,
  result: SearchCard,
  hit: number,
) {
  const range = searchRanges(root, result)[hit];
  if (!range) {
    scroller.scrollTop = 0;
    return;
  }
  let container = range.startContainer.parentElement;
  while (container && root.contains(container)) {
    if (
      container.scrollWidth > container.clientWidth &&
      /auto|scroll/.test(getComputedStyle(container).overflowX)
    ) {
      const bounds = container.getBoundingClientRect(),
        target = range.getBoundingClientRect();
      if (target.left < bounds.left)
        container.scrollLeft += target.left - bounds.left - 16;
      else if (target.right > bounds.right)
        container.scrollLeft += target.right - bounds.right + 16;
    }
    container = container.parentElement;
  }
  const box = range.getBoundingClientRect();
  scroller.scrollTop += box.top - scroller.getBoundingClientRect().top - 48;
}
