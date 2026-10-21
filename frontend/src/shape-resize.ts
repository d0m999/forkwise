import { useEffect, useRef, type RefObject, type PointerEvent, type KeyboardEvent } from "react";
import type { CanvasShape } from "../../backend/src/mapping/shape-contracts";
type Pose = CanvasShape["item"]["pose"];
export const shapeHandles = { nw: "左上", ne: "右上", sw: "左下", se: "右下" } as const;
type Handle = keyof typeof shapeHandles;
export type ShapeResizeAPI = {
  startTransform: (id: string) => boolean;
  previewTransform: (id: string, pose: Pose) => void;
  finishTransform: (id: string, pose: Pose) => void;
  enqueueTransform: (id: string, adjust: (pose: Pose) => Pose | null) => void;
  pending: boolean;
  cancel: () => void;
};
function resized(pose: Pose, handle: Handle, dx: number, dy: number): Pose | null {
  const west = handle.includes("w"), north = handle.includes("n");
  const next = { x: pose.x + (west ? dx : 0), y: pose.y + (north ? dy : 0),
    width: pose.width + (west ? -dx : dx), height: pose.height + (north ? -dy : dy) };
  return Object.values(next).every(Number.isFinite) && next.width > 0 && next.height > 0 ? next : null;
}
export function useShapeResize(value: CanvasShape, anchor: RefObject<HTMLElement | null>, api: ShapeResizeAPI, blocked: boolean) {
  const callbacks = useRef({ value, api, blocked }); callbacks.current = { value, api, blocked };
  const gesture = useRef<{ id: string; origin: Pose; next: Pose; handle: Handle; x: number; y: number;
    zoom: number; pointerId: number; element: HTMLElement } | null>(null);
  function cancel() {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null; callbacks.current.api.cancel();
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  }
  function begin(event: PointerEvent<HTMLElement>, handle: Handle) {
    if (event.button !== 0 || gesture.current || callbacks.current.blocked) return;
    event.preventDefault(); event.stopPropagation();
    const viewport = anchor.current?.closest(".react-flow__viewport");
    if (!viewport) return;
    const zoom = new DOMMatrix(getComputedStyle(viewport).transform).a, { value, api } = callbacks.current;
    if (!Number.isFinite(zoom) || zoom <= 0 || !api.startTransform(value.item.id)) return;
    const origin = { ...value.item.pose };
    gesture.current = { id: value.item.id, origin, next: origin, handle, x: event.clientX, y: event.clientY,
      zoom, pointerId: event.pointerId, element: event.currentTarget };
    event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
  }
  function key(event: KeyboardEvent<HTMLElement>, handle: Handle) {
    if (callbacks.current.blocked || gesture.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault(); event.stopPropagation();
    const { value, api } = callbacks.current, step = event.shiftKey ? 10 : 1;
    api.enqueueTransform(value.item.id, pose => resized(pose, handle, direction[0]! * step, direction[1]! * step));
  }
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const next = resized(current.origin, current.handle, (event.clientX - current.x) / current.zoom, (event.clientY - current.y) / current.zoom);
      if (!next) return;
      current.next = next; callbacks.current.api.previewTransform(current.id, next);
    };
    const up = (event: globalThis.PointerEvent) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      move(event); gesture.current = null; callbacks.current.api.finishTransform(current.id, current.next);
      if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229 && gesture.current) { event.preventDefault(); cancel(); }
    };
    const lost = (event: globalThis.PointerEvent) => { if (gesture.current?.pointerId === event.pointerId) cancel(); };
    const hidden = () => { if (document.visibilityState === "hidden") cancel(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", lost); window.addEventListener("lostpointercapture", lost);
    window.addEventListener("keydown", escape); window.addEventListener("blur", cancel); window.addEventListener("pagehide", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", lost); window.removeEventListener("lostpointercapture", lost);
      window.removeEventListener("keydown", escape); window.removeEventListener("blur", cancel); window.removeEventListener("pagehide", cancel);
      document.removeEventListener("visibilitychange", hidden); cancel();
    };
  }, []);
  return { begin, key };
}
