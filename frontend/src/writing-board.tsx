import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { captureReadingAnchor, restoreReadingAnchor, type ReadingAnchor } from "./reading-anchor";

export function WritingBoard({ projectId, cardId, opened, title, status, onClose, children }: {
  projectId: string; cardId: string; opened: number; title: string; status: string;
  onClose: () => void; children: ReactNode;
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
      return Number.isFinite(saved) && saved >= 360 ? saved : null;
    } catch { return null; }
  });
  const [notice, setNotice] = useState("");
  const narrow = workspaceWidth < 960, full = expanded || narrow;
  const max = Math.min(800, workspaceWidth - 480);
  const width = full ? workspaceWidth : Math.min(max, Math.max(360, preferred ?? Math.min(560, Math.max(420, 0.4 * workspaceWidth))));
  const dragging = useRef<{ pointer: number; x: number; width: number; original: number | null } | null>(null);
  function remember(value: number) {
    setPreferred(value);
    try { localStorage.setItem(key, String(value)); setNotice(""); }
    catch { setNotice("侧栏宽度偏好保存失败，当前宽度仍保留"); }
  }
  useEffect(() => {
    if (preferred === null && !narrow) remember(Math.min(max, Math.max(420, Math.min(560, 0.4 * workspaceWidth))));
  }, [preferred, narrow, max, workspaceWidth]);
  useLayoutEffect(() => {
    const workspace = board.current!.closest<HTMLElement>(".workspace")!;
    const measure = () => setWorkspaceWidth(workspace.clientWidth);
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
    if (!anchor.current) anchor.current = captureReadingAnchor(scroll.current!);
    const frame = requestAnimationFrame(() => { restoring.current = false; });
    return () => cancelAnimationFrame(frame);
  }, [width, full, projectId, cardId, opened]);
  useEffect(() => {
    const workspace = board.current!.closest<HTMLElement>(".workspace")!;
    return () => { workspace.style.removeProperty("--board-width"); delete workspace.dataset.boardFull; };
  }, []);
  const stop = () => {
    if (!dragging.current) return;
    setPreferred(dragging.current.original);
    dragging.current = null;
  };
  useEffect(() => {
    window.addEventListener("blur", stop);
    return () => window.removeEventListener("blur", stop);
  }, []);
  return <aside ref={board} className={`body-editor${full ? " board-full" : ""}${narrow ? " board-narrow" : ""}`} style={{ width }} aria-label="写字板" onKeyDown={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
    {!full && <div
      className="board-resizer" role="separator" aria-label="调整写字板宽度" aria-orientation="vertical"
      aria-valuemin={360} aria-valuemax={max} aria-valuenow={Math.round(width)} tabIndex={0}
      onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); anchor.current ??= captureReadingAnchor(scroll.current!); dragging.current = { pointer: e.pointerId, x: e.clientX, width, original: preferred }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { const drag = dragging.current; if (drag?.pointer === e.pointerId) setPreferred(Math.max(360, Math.min(max, drag.width + drag.x - e.clientX))); }}
      onPointerUp={e => { const drag = dragging.current; if (drag?.pointer !== e.pointerId) return; dragging.current = null; remember(width); e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={stop} onLostPointerCapture={stop}
      onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); stop(); } else if (["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); anchor.current ??= captureReadingAnchor(scroll.current!); remember(Math.max(360, Math.min(max, width + (e.key === "ArrowLeft" ? 20 : -20)))); } }}
    />}
    <header className="board-toolbar">
      <div className="board-identity"><h2 title={title || "未命名卡片"}>正在编辑：{title || "未命名卡片"}</h2><small title={cardId}>卡片 {cardId}</small><p aria-live="polite">{status}</p></div>
      <button aria-label={expanded ? "还原写字板" : "展开写字板"} onClick={() => { anchor.current ??= captureReadingAnchor(scroll.current!); setExpanded(value => !value); }}>{expanded ? "还原" : "展开"}</button>
      <button aria-label="关闭正文" onClick={onClose}>关闭</button>
    </header>
    {narrow && <button className="board-back" onClick={onClose}>返回画布</button>}
    {notice && <p aria-live="polite">{notice}</p>}
    <div className="board-scroll" ref={scroll} onScroll={() => { if (!restoring.current) anchor.current = captureReadingAnchor(scroll.current!); }}><div className="board-document">{children}</div></div>
  </aside>;
}
