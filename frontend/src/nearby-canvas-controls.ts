import { useCallback, useLayoutEffect, useState, type RefObject } from "react";
import { useViewport } from "@xyflow/react";

type Position = { left: number; top: number };
type Side = "top" | "bottom" | "right" | "left";

const gap = 12;
const horizontal = (side: Side) => side === "top" || side === "bottom";
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function placeNear(
  anchor: DOMRect,
  { width, height }: DOMRect,
  bounds: DOMRect,
  reserved: DOMRect[],
  sides: Side[],
): Position {
  const maxX = bounds.right - width, maxY = bounds.bottom - height;
  const middleX = clamp(anchor.left + (anchor.width - width) / 2, bounds.left, maxX);
  const middleY = clamp(anchor.top, bounds.top, maxY);

  for (const side of sides) {
    const alongX = horizontal(side);
    const fixed = {
      top: anchor.top - height - gap,
      bottom: anchor.bottom + gap,
      right: anchor.right + gap,
      left: anchor.left - width - gap,
    }[side];
    if (fixed < (alongX ? bounds.top : bounds.left) || fixed > (alongX ? maxY : maxX)) continue;
    const preferred = alongX ? middleX : middleY;
    // If an endpoint is in the preferred spot, slide along the same edge
    // before trying the next edge.
    const band = alongX ? new DOMRect(bounds.left, fixed, bounds.width, height)
      : new DOMRect(fixed, bounds.top, width, bounds.height);
    const obstacles = reserved.filter(box => overlaps(box, band));
    const choices = [preferred, ...obstacles.flatMap(box => alongX
      ? [box.left - width - gap, box.right + gap]
      : [box.top - height - gap, box.bottom + gap])]
      .map(value => alongX ? clamp(value, bounds.left, maxX) : clamp(value, bounds.top, maxY))
      .sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred));
    for (const value of choices) {
      const box = new DOMRect(alongX ? value : fixed, alongX ? fixed : value, width, height);
      if (!obstacles.some(other => overlaps(box, other))) return { left: box.left, top: box.top };
    }
  }

  // A very large object can occupy every edge. Prefer the title side of the
  // card and keep its visible tags, preview, endpoints and other menu usable.
  const choices = [
    { left: middleX, top: clamp(anchor.top, bounds.top, maxY) },
    { left: middleX, top: maxY },
    ...reserved.flatMap(box => [
      { left: middleX, top: clamp(box.bottom + gap, bounds.top, maxY) },
      { left: middleX, top: clamp(box.top - height - gap, bounds.top, maxY) },
      { left: clamp(box.right + gap, bounds.left, maxX), top: middleY },
      { left: clamp(box.left - width - gap, bounds.left, maxX), top: middleY },
    ]),
  ];
  choices.sort((a, b) => Math.abs(a.left - middleX) + Math.abs(a.top - middleY) -
    Math.abs(b.left - middleX) - Math.abs(b.top - middleY));
  return choices.find(choice => !reserved.some(box => overlaps(new DOMRect(choice.left, choice.top, width, height), box)))
    ?? choices[0]!;
}

function readPositions(surface: HTMLElement, bar: HTMLElement, popup?: HTMLElement | null) {
  const canvas = surface.closest(".canvas");
  if (!canvas) return null;
  const a = surface.getBoundingClientRect(), c = canvas.getBoundingClientRect();
  const bounds = new DOMRect(c.left + 8, c.top + 8, c.width - 16, c.height - 16);
  if (!overlaps(a, c) || bounds.width <= 0 || bounds.height <= 0) return null;
  const history = canvas.closest(".workspace")?.querySelector(".canvas-history-tools");
  const reserved = [
    ...canvas.querySelectorAll(".connector-entry, .connector-endpoint, .canvas-tool-dock, .creation-tools, .canvas-zoom-tools"),
    ...(history ? [history] : []),
  ].map(element => element.getBoundingClientRect())
    .filter(box => box.width > 0 && box.height > 0 && overlaps(box, c));
  for (const path of canvas.querySelectorAll<SVGPathElement>(".canvas-connector:not(.connector-preview) > path")) {
    const screen = path.getScreenCTM();
    if (!screen) continue;
    for (const at of [0, path.getTotalLength()]) {
      const { x, y } = path.getPointAtLength(at).matrixTransform(screen);
      const box = new DOMRect(x - 8, y - 8, 16, 16);
      if (overlaps(box, c)) reserved.push(box);
    }
  }
  const cardContent = ":is(.preview, .card-visible-tags)";
  const visibleContent = surface.matches(".thought-card")
    ? surface.querySelectorAll(cardContent) : canvas.querySelectorAll(`.react-flow__node.selected ${cardContent}`);
  const text = document.createRange();
  for (const element of visibleContent) {
    const box = element.getBoundingClientRect();
    if (!overlaps(box, c)) continue;
    if (element.matches(".card-visible-tags")) {
      reserved.push(box);
      continue;
    }
    // The preview box can reserve blank height; only its visible text needs
    // protection when the card fills the canvas.
    text.selectNodeContents(element);
    for (const line of text.getClientRects()) {
      const left = Math.max(line.left, box.left), top = Math.max(line.top, box.top);
      const right = Math.min(line.right, box.right), bottom = Math.min(line.bottom, box.bottom);
      if (right > left && bottom > top) {
        const clipped = new DOMRect(left, top, right - left, bottom - top);
        if (overlaps(clipped, c)) reserved.push(clipped);
      }
    }
  }
  const barSize = bar.getBoundingClientRect();
  const toolbarPosition = placeNear(a, barSize, bounds, reserved, ["top", "bottom", "right", "left"]);
  const popupSize = popup?.getBoundingClientRect();
  const popupPosition = popupSize && placeNear(a, popupSize, bounds,
    [...reserved, new DOMRect(toolbarPosition.left, toolbarPosition.top, barSize.width, barSize.height)],
    ["right", "left", "bottom", "top"]);
  return { toolbar: toolbarPosition, popup: popupPosition, maxWidth: bounds.width, maxHeight: bounds.height };
}

export function useNearbyCanvasControls(
  anchor: RefObject<HTMLElement | null>,
  toolbar: RefObject<HTMLElement | null>,
  popup?: RefObject<HTMLElement | null>,
  active = true,
) {
  useViewport();
  const [positions, setPositions] = useState<{
    toolbar: Position;
    popup?: Position | undefined;
    maxWidth: number;
    maxHeight: number;
  } | null>(null);

  const position = useCallback(() => {
    if (!active || !anchor.current || !toolbar.current) return;
    const next = readPositions(anchor.current, toolbar.current, popup?.current);
    setPositions(previous =>
      previous?.toolbar.left === next?.toolbar.left && previous?.toolbar.top === next?.toolbar.top &&
      previous?.popup?.left === next?.popup?.left && previous?.popup?.top === next?.popup?.top &&
      previous?.maxWidth === next?.maxWidth && previous?.maxHeight === next?.maxHeight ? previous : next);
  }, [active, anchor, popup, toolbar]);
  const placePopup = useCallback((element: HTMLElement) =>
    active && anchor.current && toolbar.current
      ? readPositions(anchor.current, toolbar.current, element)?.popup ?? null
      : null, [active, anchor, toolbar]);

  useLayoutEffect(position);
  useLayoutEffect(() => {
    const surface = anchor.current, bar = toolbar.current, panel = popup?.current;
    const canvas = surface?.closest(".canvas");
    if (!surface || !bar || !canvas) return;
    const resize = new ResizeObserver(position);
    for (const element of [surface, bar, canvas, panel]) if (element) resize.observe(element);
    const move = new MutationObserver(position);
    move.observe(surface.closest(".react-flow__node") ?? surface, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      resize.disconnect();
      move.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [anchor, popup, position, toolbar]);
  return { positions, placePopup };
}
