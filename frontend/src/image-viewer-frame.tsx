import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function useImageViewerRetry() {
  const [attempt, setAttempt] = useState(0);
  const [message, setFailure] = useState<string | null>(null);
  const retry = () => {
    setFailure(null);
    setAttempt(value => value + 1);
  };
  return { attempt, setFailure, loadFailure: message ? { message, retry } : undefined };
}

export function ImageViewerFrame({ label, width, height, resetKey, toolbar, loadFailure, children, onClose }: {
  label: string; width: number; height: number; resetKey?: string; toolbar?: ReactNode;
  loadFailure?: { message: string; retry: () => void } | undefined;
  children: (style: CSSProperties) => ReactNode; onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0, fit: true });
  const pan = useRef<{ pointer: number; x: number; y: number; originalX: number; originalY: number } | null>(null);
  function fit() {
    const area = stage.current!; pan.current = null;
    setView({ scale: Math.min(1, area.clientWidth / width, area.clientHeight / height), x: 0, y: 0, fit: true });
  }
  useLayoutEffect(fit, [width, height, resetKey]);
  useLayoutEffect(() => { closeButton.current!.focus(); }, []);
  useEffect(() => {
    const observer = new ResizeObserver(() => { if (view.fit) fit(); });
    observer.observe(stage.current!); return () => observer.disconnect();
  }, [view.fit, width, height, resetKey]);
  function zoom(factor: number) {
    setView(v => ({ ...v, fit: false, scale: Math.max(0.01, Math.min(16, v.scale * factor)) }));
  }
  return createPortal(<div ref={dialog} className="body-image-viewer" data-gif-scope="" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.25); }
      if (event.key === '-') { event.preventDefault(); zoom(0.8); }
      if (event.key === 'Tab') {
        const buttons = Array.from(dialog.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault(); buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]!.focus();
      }
    }} onPointerDown={event => event.stopPropagation()}>
    <div className="body-image-viewer-toolbar">
      <button onClick={fit}>适应窗口</button>
      <button onClick={() => { pan.current = null; setView({ scale: 1, x: 0, y: 0, fit: false }); }}>100%</button>
      <button aria-label="缩小图片" onClick={() => zoom(0.8)}>−</button>
      <output aria-label="图片缩放比例">{Math.round(view.scale * 100)}%</output>
      <button aria-label="放大图片" onClick={() => zoom(1.25)}>＋</button>
      {toolbar}
      <div className="body-image-viewer-feedback" data-image-viewer-gif-feedback="" />
      {loadFailure && <div className="body-image-viewer-feedback">
        <span role="alert">{loadFailure.message}</span>
        <button type="button" onClick={event => {
          if (document.activeElement === event.currentTarget) closeButton.current!.focus();
          loadFailure.retry();
        }}>重新加载图片</button>
      </div>}
      <button ref={closeButton} aria-label="关闭大图" onClick={onClose}>关闭</button>
    </div>
    <div ref={stage} className="body-image-stage" onWheel={event => { event.preventDefault(); event.stopPropagation(); zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1); }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, originalX: view.x, originalY: view.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={event => {
        const current = pan.current;
        if (current?.pointer === event.pointerId) setView(v => ({ ...v, fit: false, x: current.originalX + event.clientX - current.x, y: current.originalY + event.clientY - current.y }));
      }} onPointerUp={event => { if (pan.current?.pointer === event.pointerId) { pan.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }}
      onPointerCancel={() => { pan.current = null; }} onLostPointerCapture={() => { pan.current = null; }}>
      {children({ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: 'center', flex: 'none' })}
    </div>
  </div>, document.body);
}
