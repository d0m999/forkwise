import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LayerAvailability, LayerOperation } from "./layer-order";

export type LayerMenuProps = {
  availability: LayerAvailability;
  blocked: boolean;
  apply: (operation: LayerOperation) => void;
};

const operations: [LayerOperation, string][] = [
  ["front", "置顶"],
  ["forward", "前移一层"],
  ["backward", "后移一层"],
  ["back", "置底"],
];

export function LayerMenu({ availability, blocked, apply }: LayerMenuProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState<{ left: number; top: number } | null>(null);
  function close(restore = true) {
    setOpen(false);
    if (restore && trigger.current?.isConnected) trigger.current.focus();
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
    const box = trigger.current?.getBoundingClientRect(),
      size = menu.current?.getBoundingClientRect();
    if (!box || !size) return;
    const left = Math.max(8, Math.min(box.left, innerWidth - size.width - 8));
    const top = box.bottom + 4 + size.height <= innerHeight - 8
      ? box.bottom + 4
      : Math.max(8, box.top - size.height - 4);
    setPoint(current => current?.left === left && current.top === top ? current : { left, top });
  }, [open, availability]);
  useEffect(() => {
    if (open && point) menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, point]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={blocked}
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
