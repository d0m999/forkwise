import { useEffect, useLayoutEffect, useRef } from "react";
import { textColors } from "./text-options";
import { hexColor } from "./text-runs";

export function TextColorPicker({ open, setOpen, color, apply, restoreFocus }: {
  open: boolean;
  setOpen: (open: boolean) => void;
  color?: string | undefined;
  apply: (color: string | undefined) => void;
  restoreFocus?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (open) panel.current?.querySelector("button")?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, setOpen]);

  function close(restore = true) {
    setOpen(false);
    if (restoreFocus) { if (restore) restoreFocus(); }
    else trigger.current?.focus({ preventScroll: true });
  }

  return (
    <div ref={root} onBlur={event => {
      if (open && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }} onKeyDown={event => {
      if (!open || event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }}>
      <button ref={trigger} aria-label="文字颜色" aria-expanded={open} style={{ color }}
        onClick={() => { if (open) close(); else setOpen(true); }}>
        颜色
      </button>
      {open && <div ref={panel} className="text-color-panel" role="group" aria-label="文字颜色选项">
        {textColors.map(({ key, label }) => (
          <button key={key} className={`textColor-${key}`} onClick={event => {
            apply(key === "default" ? undefined : hexColor(getComputedStyle(event.currentTarget).color));
            close(false);
          }}>
            {label}文字
          </button>
        ))}
      </div>}
    </div>
  );
}
