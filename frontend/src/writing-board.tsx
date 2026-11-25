import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { captureReadingAnchor, restoreReadingAnchor, type ReadingAnchor } from "./reading-anchor";

const DEFAULT_WIDTH = 440;
const MIN_WIDTH = 360;
const MAX_WIDTH = 800;

export function WritingBoard({ projectId, cardId, opened, title, status, identifyCard, saveFailure, onClose, children }: {
  projectId: string; cardId: string; opened: number; title: string; status: string;
  identifyCard: boolean; saveFailure?: ReactNode; onClose: () => void; children: ReactNode;
}) {
  const board = useRef<HTMLElement>(null), scroll = useRef<HTMLDivElement>(null);
  const anchor = useRef<ReadingAnchor | null>(null);
  const restoring = useRef(false);
  const identity = useRef("");
  const [workspaceWidth, setWorkspaceWidth] = useState(innerWidth);
  const [expanded, setExpanded] = useState(false);
  const key = "forkwise:writing-board-width:" + projectId;
  const [preferred, setPreferred] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      return Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : null;
    } catch { return null; }
  });
  const [notice, setNotice] = useState("");
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const narrow = workspaceWidth < 960, full = expanded || narrow;
  const max = Math.min(MAX_WIDTH, workspaceWidth - 480);
  const clamp = (value: number) => Math.min(max, Math.max(MIN_WIDTH, value));
  const width = full ? workspaceWidth : clamp(dragWidth ?? preferred ?? DEFAULT_WIDTH);
  const documentTitle = title || "未命名卡片";
  const dragging = useRef<{ pointer: number; x: number; width: number; workspaceWidth: number } | null>(null);
  function readingPosition() {
    const scroller = scroll.current!;
    return scroller.scrollTop > 0 ? captureReadingAnchor(scroller) : null;
  }
  function remember(value: number | null) {
    setPreferred(value);
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
      setNotice("");
    }
    catch { setNotice("侧栏宽度偏好保存失败，当前宽度仍保留"); }
  }
  useLayoutEffect(() => {
    const workspace = board.current!.closest<HTMLElement>(".workspace")!;
    const measure = () => {
      const measured = workspace.clientWidth;
      if (dragging.current && dragging.current.workspaceWidth !== measured) stop();
      setWorkspaceWidth(measured);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    const mutation = new MutationObserver(measure);
    mutation.observe(workspace, { attributes: true, attributeFilter: ["style"] });
    return () => { observer.disconnect(); mutation.disconnect(); };
  }, []);
  useLayoutEffect(() => {
    const workspace = board.current!.closest<HTMLElement>(".workspace")!;
    workspace.style.setProperty("--board-width", `${full ? 0 : width}px`);
    workspace.dataset.boardFull = String(full);
    const next = `${projectId}:${cardId}:${opened}`;
    if (identity.current !== next) {
      identity.current = next;
      scroll.current!.scrollTop = 0;
      anchor.current = null;
    } else {
      restoring.current = true;
      restoreReadingAnchor(scroll.current!, anchor.current);
    }
    const frame = requestAnimationFrame(() => { restoring.current = false; });
    return () => cancelAnimationFrame(frame);
  }, [width, full, projectId, cardId, opened]);
  useEffect(() => {
    const workspace = board.current!.closest<HTMLElement>(".workspace")!;
    return () => { workspace.style.removeProperty("--board-width"); delete workspace.dataset.boardFull; };
  }, []);
  const stop = () => {
    if (!dragging.current) return;
    dragging.current = null;
    setDragWidth(null);
  };
  useEffect(() => {
    window.addEventListener("blur", stop);
    return () => window.removeEventListener("blur", stop);
  }, []);
  return <aside ref={board} className={`body-editor${full ? " board-full" : ""}${narrow ? " board-narrow" : ""}`} style={{ width }} aria-label="写字板" onKeyDown={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
    {!full && <div
      className="board-resizer" role="separator" aria-label="调整写字板宽度" aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH} aria-valuemax={max} aria-valuenow={Math.round(width)} tabIndex={0}
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.preventDefault();
        anchor.current ??= readingPosition();
        dragging.current = { pointer: e.pointerId, x: e.clientX, width, workspaceWidth };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const drag = dragging.current;
        if (drag?.pointer === e.pointerId) setDragWidth(clamp(drag.width + drag.x - e.clientX));
      }}
      onPointerUp={e => {
        const drag = dragging.current;
        if (drag?.pointer !== e.pointerId) return;
        const next = clamp(drag.width + drag.x - e.clientX);
        stop();
        const measured = board.current!.closest<HTMLElement>(".workspace")!.clientWidth;
        if (measured === drag.workspaceWidth && e.clientX !== drag.x && next !== drag.width) remember(next);
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={stop} onLostPointerCapture={stop}
      onKeyDown={e => {
        if (e.key === "Escape") { e.preventDefault(); stop(); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const next = clamp(width + (e.key === "ArrowLeft" ? 20 : -20));
          if (next === width) return;
          anchor.current ??= readingPosition();
          remember(next);
        }
      }}
    />}
    <header className="board-toolbar">
      {narrow && <button onClick={onClose}>返回画布</button>}
      <div className="board-indicators">
        {identifyCard && <p className="board-current-card" title={documentTitle}>正在编辑：{documentTitle}</p>}
        <p className="board-status" aria-live="polite"
          data-saved={status === "已保存到本机" || status === "正文已保存"}
          data-failed={status === "保存未完成"}>{status}</p>
      </div>
      <div className="board-actions">
        <details className="board-details" key={cardId}
          onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }}
          onKeyDown={e => {
            if (e.key !== "Escape" || !e.currentTarget.open) return;
            e.preventDefault();
            e.currentTarget.open = false;
            e.currentTarget.querySelector("summary")!.focus();
          }}>
          <summary>详情</summary>
          <div className="board-details-content">
            <p className="board-card-id">卡片 ID：{cardId}</p>
            <p className="media-limits">图片格式为 JPEG、PNG、WebP、GIF 和静态 SVG。每次添加合计最多 512 KiB，单张图片最多 4000 万像素。SVG 仅支持安全静态子集，拒绝脚本、外联和动效。</p>
            <button type="button" onClick={e => {
              anchor.current ??= readingPosition();
              remember(null);
              const details = e.currentTarget.closest("details")!;
              details.open = false;
              details.querySelector("summary")!.focus();
            }}>恢复默认宽度</button>
          </div>
        </details>
        {!narrow && <button aria-label={expanded ? "还原写字板" : "展开写字板"} onClick={() => {
          anchor.current ??= readingPosition();
          setExpanded(value => !value);
        }}>{expanded ? "还原" : "展开"}</button>}
        <button aria-label="关闭正文" onClick={onClose}>关闭</button>
      </div>
    </header>
    {saveFailure && <div className="board-save-failure">{saveFailure}</div>}
    {notice && <p className="board-notice" aria-live="polite">{notice}</p>}
    <div className="board-scroll" ref={scroll} onScroll={() => {
      if (!restoring.current) anchor.current = readingPosition();
    }}>
      <div className="board-document">
        <h2 className="board-title" title={documentTitle}>{documentTitle}</h2>
        {children}
      </div>
    </div>
  </aside>;
}
