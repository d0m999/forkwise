import { useEffect, useRef, useState } from "react";
import type { CanvasShape } from "../../backend/src/mapping/shape-contracts";

export type ShapeType = CanvasShape["content"]["shapeType"];
export const shapeLabels: Record<ShapeType, string> = {
  rectangle: "矩形", roundedRectangle: "圆角矩形", ellipse: "椭圆", diamond: "菱形", triangle: "三角形",
};

export function ShapeTools({ placing, disabled, choose }: {
  placing: ShapeType | null; disabled: boolean; choose: (type: ShapeType) => void;
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
      aria-pressed={placing !== null} onClick={() => setOpen(value => !value)}>形状</button>
    {open && <div role="menu" aria-label="形状预设" className="canvas-preset-menu" style={{
      position: "absolute", bottom: "calc(100% + 12px)", left: 0,
      display: "grid", minWidth: 144,
    }}>
      {(Object.entries(shapeLabels) as [ShapeType, string][]).map(([type, label]) =>
        <button key={type} role="menuitem" disabled={disabled} style={{ textAlign: "left" }}
          onClick={() => { setOpen(false); choose(type); }}>{label}</button>)}
    </div>}
  </div>;
}
