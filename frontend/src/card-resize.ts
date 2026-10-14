import {
  useEffect,
  useRef,
  type PointerEvent,
  type KeyboardEvent,
} from "react";
import type { Card } from "./api";

type Pose = Card["item"]["pose"];
interface ResizeInterface {
  start: (card: Card) => boolean;
  preview: (id: string, pose: Pose) => void;
  finish: () => void;
  cancel: () => void;
  zoom: () => number;
}
function resized(p: Pose, direction: string, dx: number, dy: number): Pose {
  const width = Math.max(
    120,
    p.width +
      (direction.includes("w") ? -dx : direction.includes("e") ? dx : 0),
  );
  const height = Math.max(
    direction.includes("n") || direction.includes("s") ? 80 : p.height,
    p.height +
      (direction.includes("n") ? -dy : direction.includes("s") ? dy : 0),
  );
  return {
    width,
    height,
    x: direction.includes("w") ? p.x + p.width - width : p.x,
    y: direction.includes("n") ? p.y + p.height - height : p.y,
  };
}
export function useCardResize(input: ResizeInterface) {
  const callbacks = useRef(input);
  callbacks.current = input;
  const gesture = useRef<{
    card: Card;
    direction: string;
    x: number;
    y: number;
    pointerId: number;
    element: HTMLElement;
    zoom: number;
  } | null>(null);
  function cancel() {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    callbacks.current.cancel();
    if (current.element.hasPointerCapture(current.pointerId))
      current.element.releasePointerCapture(current.pointerId);
  }
  function start(
    event: PointerEvent<HTMLElement>,
    card: Card,
    direction: string,
  ) {
    if (event.button !== 0 || gesture.current) return;
    event.preventDefault();
    event.stopPropagation();
    if (!callbacks.current.start(card)) return;
    gesture.current = {
      card,
      direction,
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      element: event.currentTarget,
      zoom: callbacks.current.zoom(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function key(
    event: KeyboardEvent<HTMLElement>,
    card: Card,
    direction: string,
  ) {
    if (
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      gesture.current
    )
      return;
    const delta = {
      ArrowLeft: [-10, 0],
      ArrowRight: [10, 0],
      ArrowUp: [0, -10],
      ArrowDown: [0, 10],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    if (!callbacks.current.start(card)) return;
    callbacks.current.preview(
      card.item.id,
      resized(card.item.pose, direction, delta[0]!, delta[1]!),
    );
    callbacks.current.finish();
  }
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const { card, direction, zoom } = current,
        p = card.item.pose;
      const dx = (event.clientX - current.x) / zoom,
        dy = (event.clientY - current.y) / zoom;
      callbacks.current.preview(card.item.id, resized(p, direction, dx, dy));
    };
    const up = (event: globalThis.PointerEvent) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      gesture.current = null;
      callbacks.current.finish();
      if (current.element.hasPointerCapture(current.pointerId))
        current.element.releasePointerCapture(current.pointerId);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      cancel();
    };
  }, []);
  return { start, cancel, key };
}
