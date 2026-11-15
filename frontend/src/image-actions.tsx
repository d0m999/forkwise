import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useViewport } from '@xyflow/react';
import type { ImagePose } from './image-geometry';
import { LayerMenu, type LayerMenuProps } from './layer-menu';
export function ImageActions({ anchor, pose, blocked, rotate, remove, view, crop, restore, removeFromGroup, layer }: {
  anchor: RefObject<HTMLElement | null>; pose: ImagePose; blocked: boolean; rotate: (direction: 'left' | 'right') => void; remove: () => void; view: () => void; crop: () => void; restore?: (() => void) | undefined;
  removeFromGroup?: (() => void) | undefined; layer?: LayerMenuProps | undefined;
}) {
  const toolbar = useRef<HTMLDivElement>(null), viewport = useViewport();
  const [point, setPoint] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const box = anchor.current?.getBoundingClientRect(), menu = toolbar.current?.getBoundingClientRect(), bounds = anchor.current?.closest('.canvas')?.getBoundingClientRect();
      if (!box || !menu || !bounds) return;
      const inset = Number.parseFloat(getComputedStyle(anchor.current!).getPropertyValue('--body-section-gap'));
      const left = Math.max(bounds.left + inset, Math.min(box.left, bounds.right - menu.width - inset));
      const top = box.top - menu.height - inset >= bounds.top + inset ? box.top - menu.height - inset : Math.min(box.bottom + inset, bounds.bottom - menu.height - inset);
      setPoint(previous => previous.left === left && previous.top === top ? previous : { left, top });
    };
    measure(); const observer = new ResizeObserver(measure);
    if (anchor.current) observer.observe(anchor.current);
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [viewport.x, viewport.y, viewport.zoom, pose.x, pose.y, pose.width, pose.height]);
  return createPortal(<div ref={toolbar} className="shape-text-actions shape-text-actions--floating" role="toolbar" aria-label="图片操作" style={point}>
    <button disabled={blocked} onClick={view}>查看大图</button>
    <button disabled={blocked} onClick={crop}>裁剪</button>
    {restore && <button disabled={blocked} onClick={restore}>恢复完整图片</button>}
    <button disabled={blocked} onClick={() => rotate('left')}>向左旋转90°</button>
    <button disabled={blocked} onClick={() => rotate('right')}>向右旋转90°</button>
    <button disabled={blocked} onClick={remove}>删除图片</button>
    {layer && <LayerMenu {...layer} />}
    {removeFromGroup && <button disabled={blocked} onClick={event => { event.stopPropagation(); removeFromGroup(); }}>移出组合</button>}
  </div>, document.body);
}
