import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useViewport } from "@xyflow/react";
import { CardIcon } from "./card-icons";
import type { Card } from "./api";
import { LayerMenu, type LayerMenuProps } from "./layer-menu";

import { TITLE_COLORS } from "../../backend/src/mapping/presentation-values";
export const cardColors = Object.entries(TITLE_COLORS);
type Appearance = Pick<
  NonNullable<Card["appearance"]>,
  "titleColor" | "showPreview"
>;
export function CardMenu({
  anchor,
  card,
  value,
  blocked,
  onEdit,
  onBody,
  onDelete,
  onRemoveFromGroup,
  onAppearance,
  layer,
}: {
  anchor: RefObject<HTMLElement | null>;
  card: Card;
  blocked: boolean;
  value: Appearance;
  onEdit: () => void;
  onBody: () => void;
  onDelete: () => void;
  onRemoveFromGroup?: (() => void) | undefined;
  onAppearance: (value: Appearance) => void;
  layer?: LayerMenuProps | undefined;
}) {
  const [open, setOpen] = useState<"外观" | "AI" | "更多" | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const toolbar = useRef<HTMLDivElement>(null),
    popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [positions, setPositions] = useState({
    toolbar: { left: 0, top: 0 },
    popup: { left: 0, top: 0 },
  });
  const viewport = useViewport();
  function close(restore = true) {
    setOpen(null);
    if (restore && trigger.current?.isConnected) trigger.current.focus();
  }
  useEffect(() => {
    if (!open) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    const outside = (e: PointerEvent) => {
      if (
        popup.current?.contains(e.target as Node) ||
        toolbar.current?.contains(e.target as Node)
      )
        return;
      // Let a clicked editor/button receive its own focus; canvas retains the trigger.
      const interactive = (e.target as Element).closest(
        "input,textarea,button,a,[contenteditable=true],[tabindex]",
      );
      close(!interactive);
    };
    window.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    function position() {
      const a = anchor.current?.getBoundingClientRect(),
        t = toolbar.current?.getBoundingClientRect();
      const bounds = anchor.current
        ?.closest(".canvas")
        ?.getBoundingClientRect();
      if (!a || !t || !bounds) return;
      const gap = 12,
        leftEdge = Math.max(8, bounds.left + 8),
        rightEdge = Math.min(innerWidth - 8, bounds.right - 8);
      const topEdge = Math.max(8, bounds.top + 8),
        bottomEdge = Math.min(innerHeight - 8, bounds.bottom - 8);
      const clamp = (n: number, low: number, high: number) =>
        Math.max(low, Math.min(n, Math.max(low, high)));
      const toolbarPos = {
        left: clamp(a.left, leftEdge, rightEdge - t.width),
        top:
          a.top - gap - t.height >= topEdge
            ? a.top - gap - t.height
            : clamp(a.bottom + gap, topEdge, bottomEdge - t.height),
      };
      const p = popup.current?.getBoundingClientRect();
      let popupPos = {
        left: toolbarPos.left,
        top: toolbarPos.top + t.height + gap,
      };
      if (p) {
        const candidates = [
          { left: a.right + gap, top: a.top },
          { left: a.left - p.width - gap, top: a.top },
          { left: a.left, top: a.bottom + gap },
          { left: a.left, top: a.top - p.height - gap },
        ];
        popupPos =
          candidates.find(
            (c) =>
              c.left >= leftEdge &&
              c.left + p.width <= rightEdge &&
              c.top >= topEdge &&
              c.top + p.height <= bottomEdge,
          ) ?? popupPos;
        popupPos = {
          left: clamp(popupPos.left, leftEdge, rightEdge - p.width),
          top: clamp(popupPos.top, topEdge, bottomEdge - p.height),
        };
      }
      setPositions((previous) =>
        JSON.stringify(previous) ===
        JSON.stringify({ toolbar: toolbarPos, popup: popupPos })
          ? previous
          : { toolbar: toolbarPos, popup: popupPos },
      );
    }
    position();
    const observer = new ResizeObserver(position);
    if (anchor.current) observer.observe(anchor.current);
    if (toolbar.current) observer.observe(toolbar.current);
    if (popup.current) observer.observe(popup.current);
    const canvas = anchor.current?.closest(".canvas");
    if (canvas) observer.observe(canvas);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [card, open, viewport.x, viewport.y, viewport.zoom]);
  useEffect(() => {
    if (open)
      popup.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
  }, [open]);
  return createPortal(
    <>
      <div
        ref={toolbar}
        className="card-actions card-floating nodrag nopan"
        role="toolbar"
        aria-label="卡片操作"
        style={positions.toolbar}
        onClick={event => event.stopPropagation()}
      >
        <button disabled={blocked} onClick={onEdit}>
          编辑标题
        </button>
        {layer && <LayerMenu {...layer} />}
        {(["写字板", "外观", "AI", "更多"] as const).map((name) => (
          <span className="card-icon-wrap" key={name}>
            <button
              aria-label={name}
              aria-expanded={name === "写字板" ? undefined : open === name}
              aria-pressed={name === "写字板" ? undefined : open === name}
              aria-describedby={
                hint === name ? `hint-${card.id}-${name}` : undefined
              }
              disabled={blocked && name !== "外观"}
              onMouseEnter={() => setHint(name)}
              onMouseLeave={() => setHint(null)}
              onFocus={() => setHint(name)}
              onBlur={() => setHint(null)}
              onClick={(e) => {
                if (name === "写字板") {
                  close(false);
                  onBody();
                  return;
                }
                trigger.current = e.currentTarget;
                setOpen((previous) => (previous === name ? null : name));
              }}
            >
              <CardIcon name={name} />
            </button>
            {hint === name && (
              <span
                id={`hint-${card.id}-${name}`}
                role="tooltip"
                className="card-tooltip"
              >
                {name}
              </span>
            )}
          </span>
        ))}
      </div>
      {open && (
        <div
          ref={popup}
          className="card-popup card-floating nodrag nopan"
          role="dialog"
          aria-label={open === "外观" ? "卡片外观" : open}
          style={positions.popup}
          onClick={event => event.stopPropagation()}
        >
          <div className="card-popup-heading">
            <strong>{open === "外观" ? "卡片外观" : open}</strong>
            <button aria-label="关闭卡片菜单" onClick={() => close()}>
              <CardIcon name="关闭" />
            </button>
          </div>
          {open === "外观" ? (
            <>
              <fieldset>
                <legend>标题颜色</legend>
                <div className="card-color-grid">
                  {cardColors.map(([label, color]) => (
                    <button
                      key={color}
                      aria-label={label}
                      aria-pressed={value.titleColor === color}
                      className={`card-color card-color-${color.slice(1)}`}
                      disabled={blocked}
                      onClick={() =>
                        onAppearance({ ...value, titleColor: color })
                      }
                    />
                  ))}
                </div>
              </fieldset>
              <label className="card-preview-toggle">
                <input
                  type="checkbox"
                  checked={value.showPreview}
                  aria-disabled={blocked}
                  onChange={(e) => {
                    // Native disabled clears keyboard focus during history
                    // travel. Keep focus and guard the write until it ends.
                    if (!blocked)
                      onAppearance({ ...value, showPreview: e.target.checked });
                  }}
                />
                显示正文预览
              </label>
            </>
          ) : open === "AI" ? (
            <p>AI 整理与查证尚未接入。此入口不会发送材料。</p>
          ) : (
            <>
              <button
                disabled={blocked}
                onClick={() => {
                  close(false);
                  onEdit();
                }}
              >
                编辑标题
              </button>
              <button
                disabled={blocked}
                onClick={() => {
                  close(false);
                  onBody();
                }}
              >
                打开写字板
              </button>
              <button disabled={blocked} onClick={() => { close(false); onDelete(); }}>删除卡片</button>
              {onRemoveFromGroup && <button disabled={blocked} onClick={event => { event.stopPropagation(); close(false); onRemoveFromGroup(); }}>移出组合</button>}
            </>
          )}
        </div>
      )}
    </>,
    document.body,
  );
}
