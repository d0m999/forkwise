import { useEffect, useRef, type RefObject, type PointerEvent, type KeyboardEvent } from 'react';
import type { CanvasImage } from '../../backend/src/mapping/image-contracts';
import type { ImageGeometry, ImagePose } from './image-geometry';
export const imageHandles = { nw: '左上', n: '上', ne: '右上', e: '右', se: '右下', s: '下', sw: '左下', w: '左' } as const;
type Handle = keyof typeof imageHandles;
function resized(pose: ImagePose, handle: Handle, dx: number, dy: number): ImagePose | null {
  if (dx === 0 && dy === 0) return pose;
  const west = handle.includes('w'), north = handle.includes('n');
  let width = pose.width + (west ? -dx : handle.includes('e') ? dx : 0);
  let height = pose.height + (north ? -dy : handle.includes('s') ? dy : 0);
  if (handle.length === 2) {
    const horizontal = (west ? -dx : dx) / pose.width, vertical = (north ? -dy : dy) / pose.height;
    if (Math.abs(horizontal) >= Math.abs(vertical)) height = width * pose.height / pose.width;
    else width = height * pose.width / pose.height;
  }
  const next = { ...pose, x: pose.x + (west ? pose.width - width : 0), y: pose.y + (north ? pose.height - height : 0), width, height };
  return Object.values(next).every(Number.isFinite) && width >= 1 && height >= 1 ? next : null;
}
export function useImageResize(value: CanvasImage, anchor: RefObject<HTMLElement | null>, api: ImageGeometry, blocked: boolean) {
  const latest = useRef({ value, api, blocked }); latest.current = { value, api, blocked };
  const gesture = useRef<{ origin: ImagePose; next: ImagePose; handle: Handle; x: number; y: number; zoom: number; pointerId: number; element: HTMLElement } | null>(null);
  function cancel() {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null; latest.current.api.cancel();
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  }
  function begin(event: PointerEvent<HTMLElement>, handle: Handle) {
    if (event.button !== 0 || gesture.current || latest.current.blocked) return;
    event.preventDefault(); event.stopPropagation();
    const viewport = anchor.current?.closest('.react-flow__viewport');
    if (!viewport) return;
    const zoom = new DOMMatrix(getComputedStyle(viewport).transform).a;
    if (!Number.isFinite(zoom) || zoom <= 0 || !latest.current.api.start(latest.current.value)) return;
    const origin = { ...latest.current.value.item.pose };
    gesture.current = { origin, next: origin, handle, x: event.clientX, y: event.clientY, zoom, pointerId: event.pointerId, element: event.currentTarget };
    event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
  }
  function key(event: KeyboardEvent<HTMLElement>, handle: Handle) {
    if (latest.current.blocked || gesture.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    latest.current.api.adjust(latest.current.value, resized(latest.current.value.item.pose, handle, delta[0]! * step, delta[1]! * step));
  }
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const next = resized(current.origin, current.handle, (event.clientX - current.x) / current.zoom, (event.clientY - current.y) / current.zoom);
      if (next) { current.next = next; latest.current.api.preview(next); }
    };
    const up = (event: globalThis.PointerEvent) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      move(event); gesture.current = null; latest.current.api.finish(current.next);
      if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) cancel(); };
    const lost = (event: globalThis.PointerEvent) => { if (gesture.current?.pointerId === event.pointerId) cancel(); };
    const hidden = () => { if (document.visibilityState === 'hidden') cancel(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', lost);
    window.addEventListener('lostpointercapture', lost); window.addEventListener('keydown', escape); window.addEventListener('blur', cancel); window.addEventListener('pagehide', cancel);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', lost);
      window.removeEventListener('lostpointercapture', lost); window.removeEventListener('keydown', escape); window.removeEventListener('blur', cancel); window.removeEventListener('pagehide', cancel);
      document.removeEventListener('visibilitychange', hidden); cancel();
    };
  }, []);
  return { begin, key };
}
