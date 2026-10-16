import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Block } from "../../backend/src/mapping/contracts";
import { animateBodyImage } from "./animated-body-image";

export function BodyImageViewer({
  block,
  projectId,
  playbackPreferences,
  onClose,
}: {
  block: Block;
  projectId: string;
  playbackPreferences: Map<string, boolean>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null),
    stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0, fit: true });
  const [failure, setFailure] = useState(false);
  const pan = useRef<{
    pointer: number;
    x: number;
    y: number;
    originalX: number;
    originalY: number;
  } | null>(null);
  const width = Number(block.naturalWidth),
    height = Number(block.naturalHeight);
  const url = `/api/mapping/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(String(block.assetId))}/content`;
  const mediaStyle = {
    width,
    height,
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
  };
  function fit() {
    const area = stage.current!;
    setView({
      scale: Math.min(1, area.clientWidth / width, area.clientHeight / height),
      x: 0,
      y: 0,
      fit: true,
    });
  }
  useLayoutEffect(() => {
    fit();
    dialog
      .current!.querySelector<HTMLButtonElement>('[aria-label="关闭大图"]')!
      .focus();
  }, []);
  useEffect(() => {
    const canvas = stage.current?.querySelector("canvas");
    if (!canvas) return;
    const controller = animateBodyImage(canvas, playbackPreferences, block.id);
    return controller.close;
  }, [playbackPreferences, block.id]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (view.fit) fit();
    });
    observer.observe(stage.current!);
    return () => observer.disconnect();
  }, [view.fit]);
  function zoom(factor: number) {
    setView((v) => ({
      ...v,
      fit: false,
      scale: Math.max(0.01, Math.min(16, v.scale * factor)),
    }));
  }
  return createPortal(
    <div
      className="body-image-viewer"
      data-gif-scope=""
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label="正文大图"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          zoom(1.25);
        }
        if (e.key === "-") {
          e.preventDefault();
          zoom(0.8);
        }
        if (e.key === "Tab") {
          const buttons = Array.from(
            dialog.current!.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          );
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          e.preventDefault();
          buttons[
            (index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length
          ]!.focus();
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="body-image-viewer-toolbar">
        <button onClick={fit}>适应窗口</button>
        <button onClick={() => setView({ scale: 1, x: 0, y: 0, fit: false })}>
          100%
        </button>
        <button aria-label="缩小图片" onClick={() => zoom(0.8)}>
          −
        </button>
        <output aria-label="图片缩放比例">
          {Math.round(view.scale * 100)}%
        </output>
        <button aria-label="放大图片" onClick={() => zoom(1.25)}>
          ＋
        </button>
        {block.mime === "image/gif" && (
          <button type="button" data-gif-toggle="" aria-label="播放动图">
            播放动图
          </button>
        )}
        <button aria-label="关闭大图" onClick={onClose}>
          关闭
        </button>
      </div>
      <div
        className="body-image-stage"
        ref={stage}
        onWheel={(e) => {
          e.preventDefault();
          e.stopPropagation();
          zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          pan.current = {
            pointer: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            originalX: view.x,
            originalY: view.y,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const p = pan.current;
          if (p?.pointer === e.pointerId)
            setView((v) => ({
              ...v,
              x: p.originalX + e.clientX - p.x,
              y: p.originalY + e.clientY - p.y,
            }));
        }}
        onPointerUp={(e) => {
          if (pan.current?.pointer === e.pointerId) {
            pan.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        }}
        onPointerCancel={() => {
          pan.current = null;
        }}
        onLostPointerCapture={() => {
          pan.current = null;
        }}
      >
        {block.mime === "image/gif" ? (
          <canvas
            data-gif-url={url}
            role="img"
            aria-label={String(block.alt || block.name)}
            width={width}
            height={height}
            style={mediaStyle}
          />
        ) : (
          <img
            src={url}
            alt={String(block.alt || block.name)}
            width={width}
            height={height}
            draggable={false}
            style={mediaStyle}
            onError={() => setFailure(true)}
          />
        )}
        {failure && <p role="alert">大图加载失败，原正文与阅读位置仍保留</p>}
      </div>
    </div>,
    document.body,
  );
}
