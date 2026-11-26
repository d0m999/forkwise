import { useState } from 'react';
import type { CanvasImage } from '../../backend/src/mapping/image-contracts';
import type { ImageAsset } from '../../backend/src/mapping/media';
import { ImageSurface } from './image-surface';
import { ImageViewerFrame, useImageViewerRetry } from './image-viewer-frame';
import { GifToggle } from './gif-toggle';
export function CanvasImageViewer({ projectId, value, asset, onClose, playbackPreferences }: {
  projectId: string; value: CanvasImage; asset: ImageAsset; onClose: () => void; playbackPreferences: Map<string, boolean>;
}) {
  const [original, setOriginal] = useState(false);
  const { attempt, setFailure, loadFailure } = useImageViewerRetry();
  const odd = value.item.pose.rotation === 90 || value.item.pose.rotation === 270;
  const poseWidth = odd ? value.item.pose.height : value.item.pose.width;
  const poseHeight = odd ? value.item.pose.width : value.item.pose.height;
  const naturalWidth = asset.width, naturalHeight = asset.height;
  // 100% uses original cropped pixels across the horizontal source axis.
  // The effect keeps the unrotated Pose aspect, then applies its quarter turn.
  const width = original ? asset.width : asset.width * value.content.crop.width;
  const height = original ? asset.height : width * poseHeight / poseWidth;
  const visibleWidth = odd ? height : width, visibleHeight = odd ? width : height;
  const image = original ? { ...value, content: { ...value.content, crop: { x: 0, y: 0, width: 1, height: 1 } } } : value;
  return <ImageViewerFrame label="图片大图" width={visibleWidth} height={visibleHeight} resetKey={original ? 'original' : 'effect'} onClose={onClose} loadFailure={loadFailure}
    toolbar={<><button onClick={() => setOriginal(value => !value)}>{original ? '查看画布效果' : '查看原图'}</button>
      {asset.mime === 'image/gif' && <GifToggle />}</>}>
    {style => <div role="img" aria-label={asset.name} style={style}>
      <ImageSurface key={attempt} projectId={projectId} value={image} width={visibleWidth} height={visibleHeight}
        onError={() => setFailure('大图加载失败，画布视角仍保留')}
        animation={asset.mime === 'image/gif' ? { naturalWidth, naturalHeight, preferences: playbackPreferences, key: value.id } : undefined} />
    </div>}
  </ImageViewerFrame>;
}
