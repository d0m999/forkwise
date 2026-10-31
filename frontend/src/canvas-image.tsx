import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import type { CanvasImage } from '../../backend/src/mapping/image-contracts';
import { api } from './api';
import { imageHandles, useImageResize } from './image-resize';
import type { ImageGeometry } from './image-geometry';
import { ImageSurface } from './image-surface';
import { ImageActions } from './image-actions';
import { ImageCrop } from './image-crop';
import { CanvasImageViewer } from './canvas-image-viewer';
import type { MediaAsset } from '../../backend/src/mapping/media';
import { GifToggle } from './gif-toggle';
import type { LayerMenuProps } from './layer-menu';

type ImageData = { value: CanvasImage; projectId: string; choose: (extend: boolean) => void; move: (dx: number, dy: number) => void; blocked: boolean; resizable: boolean; geometry: ImageGeometry;
  removeFromGroup?: (() => void) | undefined; layer?: LayerMenuProps | undefined };
export function CanvasImageNode({ data, selected }: NodeProps<Node<ImageData>>) {
  const anchor = useRef<HTMLDivElement>(null);
  const resize = useImageResize(data.value, anchor, data.geometry, data.blocked || data.geometry.pending);
  const [name, setName] = useState('独立图片');
  const [asset, setAsset] = useState<MediaAsset | null>(null), [viewer, setViewer] = useState<CanvasImage | null>(null);
  const [playbackPreferences] = useState(() => new Map<string, boolean>()), wasViewing = useRef(false);
  useLayoutEffect(() => {
    if (!viewer && wasViewing.current) anchor.current?.focus({ preventScroll: true });
    wasViewing.current = !!viewer;
  }, [viewer]);
  useEffect(() => {
    let active = true;
    void api.asset(data.projectId, data.value.content.assetId).then(asset => { if (active) { setName(asset.name); setAsset(asset); } }).catch(() => {});
    return () => { active = false; };
  }, [data.projectId, data.value.content.assetId]);
  const cropping = data.geometry.cropping?.projectId === data.projectId && data.geometry.cropping.value.id === data.value.id ? data.geometry.cropping : null;
  const wasCropping = useRef(false);
  useLayoutEffect(() => {
    if (!cropping && wasCropping.current) anchor.current?.focus({ preventScroll: true });
    wasCropping.current = !!cropping;
  }, [cropping]);
  function view() { if (!data.blocked && !data.geometry.pending && asset) setViewer(structuredClone(data.value)); }
  return <><div data-gif-scope="" inert={viewer || cropping ? true : undefined} style={{ position: 'relative', width: '100%', height: '100%', visibility: cropping ? 'hidden' : undefined }}>
  <div ref={anchor} role="img" aria-label={name} aria-disabled={data.blocked || data.geometry.pending} className="canvas-image-object nopan" tabIndex={data.blocked ? -1 : 0}
    onClick={event => { event.stopPropagation(); if (!data.blocked) { event.currentTarget.focus({ preventScroll: true }); data.choose(event.shiftKey); } }}
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); view(); }}
    onKeyDown={event => {
      if (data.blocked || data.geometry.pending || event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); data.choose(event.shiftKey); }
      const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
      if (selected && delta) { event.preventDefault(); event.stopPropagation(); data.move(delta[0]!, delta[1]!); }
      if (selected && data.resizable && event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); data.geometry.operate(data.value, 'delete'); }
    }}
    style={{ width: '100%', height: '100%', outline: selected ? 'var(--body-focus-outline-width) solid var(--canvas-selection-color)' : undefined, outlineOffset: 'var(--image-selection-offset)' }}>
    {asset && <ImageSurface projectId={data.projectId} value={data.value} width={data.value.item.pose.width} height={data.value.item.pose.height}
      animation={asset.mime === 'image/gif' ? { naturalWidth: asset.width, naturalHeight: asset.height, preferences: playbackPreferences, key: data.value.id, inactive: !!viewer || !!cropping } : undefined} />}
  </div>{asset?.mime === 'image/gif' && <GifToggle className="canvas-gif-control nodrag nopan" />}</div>
  {selected && data.resizable && !cropping && Object.entries(imageHandles).map(([handle, label]) => <button key={handle}
    className="nodrag nopan" aria-label={'调整图片尺寸：' + label} aria-disabled={data.blocked || data.geometry.pending}
    onPointerDown={event => resize.begin(event, handle as keyof typeof imageHandles)} onKeyDown={event => resize.key(event, handle as keyof typeof imageHandles)}
    onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    style={{ position: 'absolute', left: handle.includes('w') ? 0 : handle.includes('e') ? '100%' : '50%', top: handle.includes('n') ? 0 : handle.includes('s') ? '100%' : '50%',
      transform: 'translate(-50%, -50%)', width: 'var(--image-handle-size)', height: 'var(--image-handle-size)', padding: 0, zIndex: 10, background: 'var(--card-color-ffffff)', border: 'var(--text-tool-stroke) solid var(--canvas-selection-color)',
      cursor: handle.length === 1 ? handle === 'n' || handle === 's' ? 'ns-resize' : 'ew-resize' : handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize' }} />)}
    {selected && data.resizable && !cropping && <ImageActions anchor={anchor} pose={data.value.item.pose} blocked={data.blocked || data.geometry.pending || !!viewer} view={view} crop={() => { if (asset) data.geometry.beginCrop(data.value); }}
      restore={data.value.content.crop.x !== 0 || data.value.content.crop.y !== 0 || data.value.content.crop.width !== 1 || data.value.content.crop.height !== 1 ? () => data.geometry.operate(data.value, 'restore') : undefined}
      rotate={direction => data.geometry.operate(data.value, direction)} remove={() => data.geometry.operate(data.value, 'delete')} removeFromGroup={data.removeFromGroup} layer={data.layer} />}
    {cropping && asset && <ImageCrop key={cropping.value.versionId} projectId={cropping.projectId} value={cropping.value} asset={asset} playbackPreferences={playbackPreferences} blocked={data.geometry.pending} complete={data.geometry.finishCrop} cancel={data.geometry.cancel} />}
    {viewer && asset && <CanvasImageViewer projectId={data.projectId} value={viewer} asset={asset} playbackPreferences={playbackPreferences} onClose={() => setViewer(null)} />}</>;
}
export function imageNodes(images: CanvasImage[], projectId: string, selection: string[], choose: (id: string, extend: boolean) => void, blocked: boolean, geometry: ImageGeometry, move: (value: CanvasImage, dx: number, dy: number) => void, singleItemId: string | null, memberAction: (itemId: string) => (() => void) | undefined, layer?: LayerMenuProps | undefined): Node<ImageData>[] {
  return images.map(saved => { const original = geometry.cropping?.projectId === projectId && geometry.cropping.value.id === saved.id ? geometry.cropping.value : saved; const value = { ...original, item: { ...original.item, pose: geometry.poses[original.item.id] ?? original.item.pose } }; return ({ id: value.item.id, type: 'canvasImage', position: value.item.pose,
    initialWidth: value.item.pose.width, initialHeight: value.item.pose.height,
    style: { width: value.item.pose.width, height: value.item.pose.height }, draggable: !blocked && !geometry.pending && !geometry.cropping,
    selected: selection.includes(value.item.id), data: { value, projectId, choose: extend => choose(value.item.id, extend), move: (dx, dy) => move(value, dx, dy), blocked, resizable: singleItemId === value.item.id, geometry, removeFromGroup: memberAction(value.item.id), layer } }); });
}
