import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { CanvasImage } from '../../backend/src/mapping/image-contracts';
import { ImageSurface } from './image-surface';
import { imageHandles } from './image-resize';
import { GifToggle } from './gif-toggle';
import type { MediaAsset } from '../../backend/src/mapping/media';
import { useViewport } from '@xyflow/react';
type Crop = CanvasImage['content']['crop'];
type Frame = { x: number; y: number; width: number; height: number };
type Handle = keyof typeof imageHandles;
type DragHandle = Handle | 'move';
function oriented(crop: Crop, rotation: number): Crop {
  if (rotation === 90) return { x: 1 - (crop.y + crop.height), y: crop.x, width: crop.height, height: crop.width };
  if (rotation === 180) return { ...crop, x: 1 - (crop.x + crop.width), y: 1 - (crop.y + crop.height) };
  if (rotation === 270) return { x: crop.y, y: 1 - (crop.x + crop.width), width: crop.height, height: crop.width };
  return crop;
}
export function ImageCrop({ projectId, value, asset, playbackPreferences, blocked, complete, cancel }: {
  projectId: string; value: CanvasImage; asset: MediaAsset; playbackPreferences: Map<string, boolean>; blocked: boolean; complete: (crop: Crop) => void; cancel: () => void;
}) {
  const pose = value.item.pose, visible = oriented(value.content.crop, pose.rotation);
  const width = pose.width / visible.width, height = pose.height / visible.height;
  const [frame, setFrame] = useState<Frame>(() => ({ x: visible.x * width, y: visible.y * height, width: pose.width, height: pose.height }));
  const initial = useRef(frame);
  const current = useRef(frame); current.current = frame;
  const root = useRef<HTMLDivElement>(null), frameElement = useRef<HTMLDivElement>(null), toolbar = useRef<HTMLDivElement>(null);
  const viewport = useViewport();
  const [tools, setTools] = useState<{ left: number; top: number; maxWidth?: number }>({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const element = root.current, bar = toolbar.current, canvas = element?.closest('.canvas');
      const box = frameElement.current?.getBoundingClientRect();
      if (!element || !bar || !canvas || !box) return;
      const origin = element.getBoundingClientRect(), menu = bar.getBoundingClientRect(), bounds = canvas.getBoundingClientRect();
      const gap = Number.parseFloat(getComputedStyle(element).getPropertyValue('--body-section-gap')) * viewport.zoom;
      const left = Math.max(0, bounds.left) + gap, top = Math.max(0, bounds.top) + gap;
      const right = Math.min(innerWidth, bounds.right) - gap, bottom = Math.min(innerHeight, bounds.bottom) - gap;
      const x = Math.max(left, Math.min(Math.max(box.left, left), right - menu.width));
      const above = Math.max(box.top, top) - menu.height - gap;
      const desiredY = above >= top ? above : Math.min(box.bottom, bottom) + gap;
      const y = Math.max(top, Math.min(desiredY, bottom - menu.height));
      const next = { left: (x - origin.left) / viewport.zoom, top: (y - origin.top) / viewport.zoom, maxWidth: Math.max(0, right - left) / viewport.zoom };
      setTools(previous => previous.left === next.left && previous.top === next.top && previous.maxWidth === next.maxWidth ? previous : next);
    };
    measure(); const observer = new ResizeObserver(measure);
    if (toolbar.current) observer.observe(toolbar.current);
    const canvas = root.current?.closest('.canvas'); if (canvas) observer.observe(canvas);
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [frame.x, frame.y, frame.width, frame.height, viewport.x, viewport.y, viewport.zoom]);
  const drag = useRef<{ origin: Frame; x: number; y: number; zoom: number; handle: DragHandle; pointerId: number } | null>(null);
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, []);
  function resize(origin: Frame, handle: DragHandle, dx: number, dy: number) {
    if (handle === 'move') {
      const next = { ...origin, x: Math.max(0, Math.min(width - origin.width, origin.x + dx)), y: Math.max(0, Math.min(height - origin.height, origin.y + dy)) };
      if (Object.values(next).every(Number.isFinite)) { current.current = next; setFrame(next); }
      return;
    }
    let left = origin.x, top = origin.y, right = origin.x + origin.width, bottom = origin.y + origin.height;
    if (handle.includes('w')) left = Math.max(0, Math.min(right, left + dx));
    if (handle.includes('e')) right = Math.max(left, Math.min(width, right + dx));
    if (handle.includes('n')) top = Math.max(0, Math.min(bottom, top + dy));
    if (handle.includes('s')) bottom = Math.max(top, Math.min(height, bottom + dy));
    const next = { x: left, y: top, width: right - left, height: bottom - top };
    if (Object.values(next).every(Number.isFinite) && next.width > 0 && next.height > 0) { current.current = next; setFrame(next); }
  }
  function begin(event: PointerEvent<HTMLElement>, handle: DragHandle) {
    if (blocked || event.button !== 0 || drag.current) return;
    event.preventDefault(); event.stopPropagation();
    const viewport = root.current?.closest('.react-flow__viewport');
    if (!viewport) return;
    const zoom = new DOMMatrix(getComputedStyle(viewport).transform).a;
    if (!Number.isFinite(zoom) || zoom <= 0) return;
    drag.current = { origin: current.current, x: event.clientX, y: event.clientY, zoom, handle, pointerId: event.pointerId };
    event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLElement>) {
    const captured = drag.current;
    if (!captured || captured.pointerId !== event.pointerId) return;
    event.stopPropagation();
    resize(captured.origin, captured.handle, (event.clientX - captured.x) / captured.zoom, (event.clientY - captured.y) / captured.zoom);
  }
  function end(event: PointerEvent<HTMLElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    move(event); drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function key(event: KeyboardEvent<HTMLButtonElement>, handle: Handle) {
    if (blocked || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    resize(current.current, handle, delta[0]! * step, delta[1]! * step);
  }
  function finish() {
    if (blocked) return;
    const draft = current.current, original = initial.current;
    if (draft.x === original.x && draft.y === original.y && draft.width === original.width && draft.height === original.height) {
      complete(value.content.crop); return;
    }
    const crop = { x: draft.x / width, y: draft.y / height, width: draft.width / width, height: draft.height / height };
    complete(oriented(crop, (360 - pose.rotation) % 360));
  }
  const full = { ...value, content: { ...value.content, crop: { x: 0, y: 0, width: 1, height: 1 } } };
  const frameStyle = { left: frame.x, top: frame.y, width: frame.width, height: frame.height };
  return <div ref={root} data-gif-scope="" className="image-crop nodrag nopan" role="region" aria-label="图片裁剪" tabIndex={-1}
    style={{ left: -visible.x * width, top: -visible.y * height, width, height }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (blocked || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'Enter' && !(event.target as Element).closest('.image-crop-actions button')) { event.preventDefault(); finish(); }
      if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    }}>
    <div className="image-crop-source" role="img" aria-label="裁剪原图">
      <ImageSurface projectId={projectId} value={full} width={width} height={height}
        animation={asset.mime === 'image/gif' ? { naturalWidth: asset.width, naturalHeight: asset.height, preferences: playbackPreferences, key: value.id } : undefined} />
      <div className="image-crop-mask" style={frameStyle} />
    </div>
    <div ref={frameElement} className="image-crop-frame" role="group" aria-label="裁剪范围" style={frameStyle}
      onPointerDown={event => begin(event, 'move')} onPointerMove={move} onPointerUp={end}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      {Object.entries(imageHandles).map(([handle, label]) => <button key={handle} className="image-crop-handle" aria-label={'调整裁剪范围：' + label} disabled={blocked}
        onPointerDown={event => begin(event, handle as Handle)} onPointerMove={move} onPointerUp={end}
        onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={event => key(event, handle as Handle)}
        style={{ left: handle.includes('w') ? 0 : handle.includes('e') ? '100%' : '50%', top: handle.includes('n') ? 0 : handle.includes('s') ? '100%' : '50%' }} />)}
    </div>
    <div ref={toolbar} className="image-crop-actions shape-text-actions shape-text-actions--floating" role="toolbar" aria-label="裁剪操作" style={tools}>
      <button disabled={blocked} onClick={finish}>完成</button><button disabled={blocked} onClick={cancel}>取消</button>
      {asset.mime === 'image/gif' && <GifToggle />}
    </div>
  </div>;
}
