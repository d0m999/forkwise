import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { CardIcon } from "./card-icons";
import { AddAttachmentButton } from "./card-attachment-list";
import type { Card } from "./api";
import { LayerMenu, type LayerMenuProps } from "./layer-menu";
import { useNearbyCanvasControls } from "./nearby-canvas-controls";

import { TITLE_COLORS } from "../../backend/src/mapping/presentation-values";
export const cardColors = Object.entries(TITLE_COLORS);
type Appearance = Pick<
  NonNullable<Card["appearance"]>,
  "titleColor" | "showPreview"
>;
export function CardMenu({
  anchor,
  toolbar,
  tabIndex,
  card,
  value,
  attachmentWriteBlocked,
  blocked,
  onEdit,
  onBody,
  onAI,
  onVerification,
  onAddAttachment,
  onDelete,
  onRemoveFromGroup,
  onAppearance,
  layer,
}: {
  anchor: RefObject<HTMLElement | null>;
  toolbar: RefObject<HTMLDivElement | null>;
  tabIndex?: number | undefined;
  card: Card;
  attachmentWriteBlocked: boolean;
  blocked: boolean;
  value: Appearance;
  onEdit: (origin?: HTMLButtonElement) => void;
  onBody: () => void;
  onAI: () => void;
  onVerification?: (() => void) | undefined;
  onAddAttachment: (file: File) => void;
  onDelete: () => void;
  onRemoveFromGroup?: (() => void) | undefined;
  onAppearance: (value: Appearance) => void;
  layer?: LayerMenuProps | undefined;
}) {
  const [open, setOpen] = useState<"外观" | "更多" | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const { positions, placePopup } = useNearbyCanvasControls(anchor, toolbar, open ? popup : undefined);
  const popupVisible = !!positions?.popup;
  function close(restore = true) {
    setOpen(null);
    if (restore && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  }
  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (!open || !event.currentTarget.contains(event.target)) return;
    const next = event.relatedTarget;
    if (!next || popup.current?.contains(next) || next === trigger.current) return;
    close(false);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!open || event.nativeEvent.isComposing || event.keyCode === 229 ||
      !event.currentTarget.contains(event.target as Node)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab" || tabIndex !== -1 || !popupVisible ||
      event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    // The toolbar uses the card's Tab order, so the popup supplies its own
    // forward and reverse steps beside the trigger.
    const first = popup.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    const current = event.target;
    const next = event.shiftKey && current === first ? trigger.current
      : !event.shiftKey && current === trigger.current ? first
      : null;
    if (!next || next.disabled) return;
    next.focus({ preventScroll: true });
    if (document.activeElement === next) event.preventDefault();
  }
  useEffect(() => {
    if (!open) return;
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
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  useEffect(() => {
    if (open && popupVisible)
      popup.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus({ preventScroll: true });
  }, [open, popupVisible]);
  return createPortal(
    <>
      <div
        ref={toolbar}
        className="card-actions card-floating nodrag nopan"
        role="toolbar"
        aria-label="卡片操作"
        style={{ ...positions?.toolbar, visibility: positions ? undefined : "hidden" }}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onClick={event => event.stopPropagation()}
      >
        <button tabIndex={tabIndex} disabled={blocked} onClick={event => {
          close(false);
          if (!event.shiftKey) onEdit(document.activeElement === event.currentTarget ? event.currentTarget : undefined);
        }}>
          编辑标题
        </button>
        {layer && <LayerMenu {...layer} placePopup={placePopup} tabIndex={tabIndex} />}
        {(["写字板", "外观", "AI", "更多"] as const).map((name) => (
          <span className="card-icon-wrap" key={name}>
            <button
              tabIndex={tabIndex}
              aria-label={name}
              aria-haspopup={name === "AI" ? "dialog" : undefined}
              aria-expanded={name === "写字板" || name === "AI" ? undefined : open === name}
              aria-pressed={name === "写字板" || name === "AI" ? undefined : open === name}
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
                if (name === "AI") {
                  close(false);
                  onAI();
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
          style={{ ...positions?.popup, maxWidth: positions?.maxWidth, maxHeight: positions?.maxHeight,
            visibility: popupVisible ? undefined : "hidden" }}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
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
                      aria-disabled={blocked}
                      onClick={() => {
                        if (!blocked) onAppearance({ ...value, titleColor: color });
                      }}
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
          ) : (
            <>
              <button
                disabled={blocked}
                onClick={() => {
                  const origin = trigger.current ?? undefined;
                  close();
                  onEdit(origin);
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
              {onVerification && (
                <button type="button" disabled={blocked} aria-haspopup="dialog" onClick={() => {
                  close();
                  onVerification();
                }}>
                  公开查证
                </button>
              )}
              <AddAttachmentButton blocked={attachmentWriteBlocked} onAdd={file => { close(); onAddAttachment(file); }} />
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
