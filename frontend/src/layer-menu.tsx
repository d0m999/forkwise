import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useViewport } from "@xyflow/react";
import type { LayerAvailability, LayerOperation } from "./layer-order";

export type LayerMenuProps = {
  availability: LayerAvailability;
  blocked: boolean;
  apply: (operation: LayerOperation) => void;
  placePopup?: (element: HTMLElement) => { left: number; top: number } | null;
};

const operations: [LayerOperation, string][] = [
  ["front", "置顶"],
  ["forward", "前移一层"],
  ["backward", "后移一层"],
  ["back", "置底"],
];

export function LayerMenu({ availability, blocked, apply, placePopup, tabIndex }: LayerMenuProps & { tabIndex?: number | undefined }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const [point, setPoint] = useState<{ left: number; top: number } | null>(null);
  useViewport();
  // 触发按钮由父级工具条在视口变化后重新定位，故每次渲染后都要重新测量。
  function measure() {
    if (!menu.current) return;
    if (placePopup) {
      const position = placePopup(menu.current);
      setPoint(current => current?.left === position?.left && current?.top === position?.top ? current : position);
      return;
    }
    const box = trigger.current?.getBoundingClientRect();
    const size = menu.current.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(8, Math.min(box.left, innerWidth - size.width - 8));
    const top = box.bottom + 4 + size.height <= innerHeight - 8
      ? box.bottom + 4
      : Math.max(8, box.top - size.height - 4);
    setPoint(current => current?.left === left && current.top === top ? current : { left, top });
  }
  function close(restore = true) {
    setOpen(false);
    if (restore && trigger.current?.isConnected) trigger.current.focus();
  }
  function onPopupTab(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab" || tabIndex !== -1 || !open || !point ||
      event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 ||
      event.altKey || event.ctrlKey || event.metaKey) return;
    const first = menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? menu.current;
    const current = event.target;
    const next = event.shiftKey && current === first ? trigger.current
      : !event.shiftKey && current === trigger.current ? first
      : null;
    if (!next) return;
    next.focus({ preventScroll: true });
    if (document.activeElement === next) event.preventDefault();
  }
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    const outside = (event: PointerEvent) => {
      if (menu.current?.contains(event.target as Node) || trigger.current?.contains(event.target as Node)) return;
      close(false);
    };
    window.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) {
      setPoint(null);
      return;
    }
    measure();
  });
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, placePopup]);
  useEffect(() => {
    if (!open) {
      focused.current = false;
      return;
    }
    if (!point || focused.current) return;
    focused.current = true;
    const first = menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    (first ?? (placePopup ? menu.current : null))?.focus({ preventScroll: true });
  }, [open, placePopup, point]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        tabIndex={tabIndex}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={blocked}
        onKeyDown={onPopupTab}
        onBlur={event => {
          if (tabIndex === -1 && open && !menu.current?.contains(event.relatedTarget)) close(false);
        }}
        onPointerDown={event => event.stopPropagation()}
        onClick={event => {
          event.stopPropagation();
          if (!blocked) setOpen(value => !value);
        }}
      >
        层级
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            tabIndex={placePopup ? -1 : undefined}
            aria-label="层级操作"
            className="layer-menu-popup"
            style={{
              position: "fixed",
              left: point?.left ?? 0,
              top: point?.top ?? 0,
              visibility: point ? "visible" : "hidden",
            }}
            onPointerDown={event => event.stopPropagation()}
            onClick={event => event.stopPropagation()}
            onBlur={event => {
              const next = event.relatedTarget as Node | null;
              if (next && (menu.current?.contains(next) || trigger.current?.contains(next))) return;
              close(false);
            }}
            onKeyDown={event => {
              if (event.key === "Tab") return onPopupTab(event);
              const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
              const current = items.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                items[(current + step + items.length) % items.length]?.focus();
              } else if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                items[event.key === "Home" ? 0 : items.length - 1]?.focus();
              }
            }}
          >
            {operations.map(([operation, label]) => (
              <button
                key={operation}
                type="button"
                role="menuitem"
                disabled={blocked || !availability[operation]}
                onClick={() => {
                  apply(operation);
                  close(true);
                }}
              >
                {label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
