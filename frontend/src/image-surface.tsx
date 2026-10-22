import { useEffect, useRef, type CSSProperties } from 'react';
import type { CanvasImage } from '../../backend/src/mapping/image-contracts';
import { animateBodyImage } from './animated-body-image';
type Animation = { naturalWidth: number; naturalHeight: number; preferences: Map<string, boolean>; key: string; inactive?: boolean };
export function ImageSurface({ projectId, value, width, height, style, onError, animation }: {
  projectId: string; value: CanvasImage; width: number; height: number; style?: CSSProperties; onError?: () => void;
  animation?: Animation | undefined;
}) {
  const quarter = value.item.pose.rotation, odd = quarter === 90 || quarter === 270;
  const w = odd ? height : width, h = odd ? width : height, crop = value.content.crop;
  const url = `/api/mapping/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(value.content.assetId)}/content`;
  const canvas = useRef<HTMLCanvasElement>(null), controller = useRef<ReturnType<typeof animateBodyImage> | null>(null);
  useEffect(() => {
    if (!canvas.current || !animation) return;
    const current = animateBodyImage(canvas.current, animation.preferences, animation.key); controller.current = current;
    return () => { current.close(); if (controller.current === current) controller.current = null; };
  }, [url, animation?.key, animation?.preferences]);
  useEffect(() => { controller.current?.refresh(); }, [animation?.inactive]);
  const mediaStyle: CSSProperties = { display: 'block', position: 'absolute', maxWidth: 'none', maxHeight: 'none',
    width: w / crop.width, height: h / crop.height, left: -crop.x * w / crop.width, top: -crop.y * h / crop.height };
  return <div className="canvas-image-surface" style={{ position: 'relative', width, height, overflow: 'hidden', flex: 'none', ...style }}>
    <div style={{ position: 'absolute', left: '50%', top: '50%', width: w, height: h, overflow: 'hidden', transform: `translate(-50%, -50%) rotate(${quarter}deg)` }}>
      {animation ? <canvas ref={canvas} data-gif-url={url} aria-hidden="true" width={animation.naturalWidth} height={animation.naturalHeight} style={mediaStyle} />
        : <img src={url} alt="" aria-hidden="true" draggable={false} onError={onError} style={mediaStyle} />}
    </div>
  </div>;
}
