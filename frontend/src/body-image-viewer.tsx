import { useEffect, useRef } from "react";
import type { Block } from "../../backend/src/mapping/contracts";
import { animateBodyImage } from "./animated-body-image";
import { ImageViewerFrame, useImageViewerRetry } from "./image-viewer-frame";
import { readImageOriginalError } from "./image-original-status";

export function BodyImageViewer({ block, projectId, playbackPreferences, onClose }: {
  block: Block; projectId: string; playbackPreferences: Map<string, boolean>; onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { attempt, setFailure, loadFailure } = useImageViewerRetry();
  const width = Number(block.naturalWidth), height = Number(block.naturalHeight);
  const url = `/api/mapping/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(String(block.assetId))}/content`;
  useEffect(() => {
    if (!canvas.current) return;
    return animateBodyImage(canvas.current, playbackPreferences, block.id).close;
  }, [playbackPreferences, block.id]);
  return <ImageViewerFrame label="正文大图" width={width} height={height} onClose={onClose} loadFailure={loadFailure}
    toolbar={block.mime === "image/gif" ? <button type="button" data-gif-toggle="" aria-label="播放动图">播放动图</button> : undefined}>
    {style => block.mime === "image/gif" ? <canvas ref={canvas} data-gif-url={url} role="img" aria-label={String(block.alt || block.name)}
      width={width} height={height} style={style} /> : <img key={attempt} src={url} alt={String(block.alt || block.name)} width={width} height={height}
      draggable={false} style={style} onError={event => {
        const image = event.currentTarget;
        setFailure('大图加载失败，原正文与阅读位置仍保留');
        void readImageOriginalError(url).then(message => {
          if (message && image.isConnected) setFailure(message);
        });
      }} />}
  </ImageViewerFrame>;
}
