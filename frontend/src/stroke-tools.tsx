import { useEffect, useRef, useState } from "react";
import type { CanvasStroke } from "../../backend/src/mapping/stroke-contracts";

export type PenKind = CanvasStroke["content"]["penKind"];

export function StrokeTools({ active, disabled, choose }: {
  active: PenKind | null; disabled: boolean; choose: (kind: PenKind) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); setOpen(false); trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);
  return <div ref={root} style={{ position: "relative" }}>
    <button ref={trigger} disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      aria-pressed={active !== null} onClick={() => setOpen(value => !value)}>画笔</button>
    {open && <div role="menu" aria-label="画笔类型" className="canvas-preset-menu" style={{
      position: "absolute", bottom: "calc(100% + 12px)", left: 0,
      display: "grid", minWidth: 144,
    }}>
      {([['pen', '普通笔'], ['highlighter', '荧光笔']] as const).map(([kind, label]) =>
        <button key={kind} role="menuitem" disabled={disabled} style={{ textAlign: "left" }}
          onClick={() => { setOpen(false); trigger.current?.focus(); void choose(kind); }}>{label}</button>)}
    </div>}
  </div>;
}
