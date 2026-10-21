import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useViewport } from "@xyflow/react";
function toolbarGap() {
  return Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--text-tool-anchor-gap"),
  ) || 0;
}
export function TextToolbar({
  anchor,
  children,
  preserveSelection = false,
}: {
  anchor: RefObject<HTMLElement | null>;
  children: ReactNode;
  preserveSelection?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null),
    viewport = useViewport();
  const [position, setPosition] = useState(() => {
    const gap = toolbarGap();
    return { left: gap, top: gap, maxWidth: innerWidth - 2 * gap, above: false };
  });
  useLayoutEffect(() => {
    function measure() {
      const a = anchor.current?.getBoundingClientRect(),
        t = element.current?.getBoundingClientRect(),
        canvas = anchor.current?.closest(".canvas")?.getBoundingClientRect();
      if (!a || !t || !canvas) return;
      const gap = toolbarGap(),
        left = Math.max(gap, canvas.left + gap),
        right = Math.min(innerWidth - gap, canvas.right - gap),
        top = Math.max(gap, canvas.top + gap),
        bottom = Math.min(innerHeight - gap, canvas.bottom - gap);
      const clamp = (value: number, low: number, high: number) =>
        Math.max(low, Math.min(value, Math.max(low, high)));
      const y =
        a.top - gap - t.height >= top
          ? a.top - gap - t.height
          : clamp(a.bottom + gap, top, bottom - t.height);
      const palette = element.current
        ?.querySelector(".text-color-panel")
        ?.getBoundingClientRect();
      const next = {
        left: clamp(a.left, left, right - t.width),
        top: y,
        maxWidth: right - left,
        above:
          !!palette &&
          y + t.height + palette.height > bottom &&
          y - palette.height >= top,
      };
      setPosition((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    }
    measure();
    const observer = new ResizeObserver(measure);
    if (anchor.current) observer.observe(anchor.current);
    if (element.current) observer.observe(element.current);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchor, children, viewport.x, viewport.y, viewport.zoom]);
  return createPortal(
    <div
      ref={element}
      className="text-actions nodrag nopan nowheel"
      role="toolbar"
      aria-label="独立文字样式"
      data-popup-side={position.above ? "top" : "bottom"}
      style={{
        left: position.left,
        top: position.top,
        maxWidth: position.maxWidth,
      }}
      onMouseDown={(event) => {
        if (preserveSelection && !(event.target instanceof HTMLInputElement))
          event.preventDefault();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
