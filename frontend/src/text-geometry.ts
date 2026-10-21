import { useEffect, useRef, useState } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from "react";
import type { CanvasText } from "../../backend/src/mapping/text-contracts";

export const textHandles = {
  w: "左",
  e: "右",
  nw: "左上",
  ne: "右上",
  sw: "左下",
  se: "右下",
} as const;
type Handle = keyof typeof textHandles;

export function textMinimumWidth(fontSize: number) {
  return (20 * fontSize) / 18;
}

function resizeText(
  value: CanvasText,
  origin: CanvasText["item"]["pose"],
  handle: Handle,
  dx: number,
  dy: number,
): CanvasText {
  const left = handle.includes("w"),
    top = handle.includes("n"),
    corner = handle.length === 2;
  const ratio = Math.max(
    1 / value.content.fontSize,
    1 +
      ((left ? -dx : dx) * origin.width + (top ? -dy : dy) * origin.height) /
        (origin.width ** 2 + origin.height ** 2),
  );
  const width = corner
    ? origin.width * ratio
    : Math.max(textMinimumWidth(value.content.fontSize), origin.width + (left ? -dx : dx));
  const height = corner ? origin.height * ratio : origin.height;
  return {
    ...value,
    content: {
      ...value.content,
      widthMode: corner ? value.content.widthMode : "fixed",
      width: corner ? value.content.width * ratio : width,
      fontSize: corner
        ? value.content.fontSize * ratio
        : value.content.fontSize,
    },
    item: {
      ...value.item,
      pose: {
        x: origin.x + (left ? origin.width - width : 0),
        y: origin.y + (top ? origin.height - height : 0),
        width,
        height,
      },
    },
  };
}

export function useTextGeometry(
  value: CanvasText,
  element: RefObject<HTMLElement | null>,
  zoom: () => number,
  commit: (next: CanvasText, origin: CanvasText) => void,
) {
  const [preview, setPreview] = useState<CanvasText | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  function begin(event: ReactPointerEvent, handle: Handle) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cleanup.current?.();
    const bounds = element.current!.getBoundingClientRect(),
      scale = zoom();
    const origin = {
      ...value.item.pose,
      width: bounds.width / scale,
      height: bounds.height / scale,
    };
    const x = event.clientX,
      y = event.clientY;
    let next = value;
    const move = (event: PointerEvent) => {
      const dx = (event.clientX - x) / scale,
        dy = (event.clientY - y) / scale;
      next = resizeText(value, origin, handle, dx, dy);
      setPreview(next);
    };
    const dispose = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", key);
      cleanup.current = null;
    };
    const cancel = () => {
      dispose();
      setPreview(null);
    };
    const up = () => {
      dispose();
      setPreview(null);
      if (next !== value) commit(next, value);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    };
    cleanup.current = cancel;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", key);
  }
  function key(event: ReactKeyboardEvent, handle: Handle) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction || (handle.length === 1 && direction[1])) return;
    event.preventDefault();
    event.stopPropagation();
    cleanup.current?.();
    const bounds = element.current!.getBoundingClientRect(),
      scale = zoom(),
      step = event.shiftKey ? 10 : 1;
    const origin = {
      ...value.item.pose,
      width: bounds.width / scale,
      height: bounds.height / scale,
    };
    commit(
      resizeText(
        value,
        origin,
        handle,
        direction[0] * step,
        direction[1] * step,
      ),
      value,
    );
  }
  return { preview, begin, key };
}
