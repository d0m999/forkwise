import { useRef } from "react";
import { ShapeTextAction } from "./shape-text-editor";
import type { Node, NodeProps } from "@xyflow/react";
import { shapeLabels } from "./shape-tools";
import type { CanvasShape } from "../../backend/src/mapping/shape-contracts";
import { shapeHandles, useShapeResize, type ShapeResizeAPI } from "./shape-resize";

type ShapeData = { value: CanvasShape; blocked: boolean; choose: (extend: boolean) => void; edit: () => void; remove: () => void;
  appearance: (trigger: HTMLButtonElement) => void; editable: boolean; resizable: boolean; resizeBlocked: boolean; geometry: ShapeResizeAPI };

export function CanvasShapeNode({ data, selected }: NodeProps<Node<ShapeData>>) {
  const anchor = useRef<HTMLDivElement>(null);
  const resize = useShapeResize(data.value, anchor, data.geometry, data.resizeBlocked);
  const content = data.value.content;
  const polygon = content.shapeType === "diamond" ? "50,0 100,50 50,100 0,50"
    : content.shapeType === "triangle" ? "50,0 100,100 0,100" : null;
  return (
    <>
    <div ref={anchor}
      role="img"
      className="nopan"
      tabIndex={data.blocked ? -1 : 0}
      aria-disabled={data.blocked}
      onClick={event => {
        event.stopPropagation();
        if (!data.blocked) { event.currentTarget.focus({ preventScroll: true }); data.choose(event.shiftKey); }
      }}
      onDoubleClick={event => {
        event.preventDefault(); event.stopPropagation();
        if (!data.blocked) data.edit();
      }}
      onKeyDown={event => {
        if (data.blocked || event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault(); event.stopPropagation(); data.choose(event.shiftKey);
        }
        if (event.key === "Delete" && selected && data.editable) {
          event.preventDefault(); event.stopPropagation(); data.remove();
        }
      }}
      aria-label={content.shortText || shapeLabels[content.shapeType]}
      style={{
        width: "100%", height: "100%", boxSizing: "border-box",
        backgroundColor: polygon ? "transparent" : content.fill ?? "transparent",
        border: polygon ? undefined : `${content.strokeWidth ?? 1}px solid ${content.stroke ?? "#cbd5e1"}`,
        borderRadius: content.shapeType === "ellipse" ? "50%" : content.shapeType === "roundedRectangle" ? 12 : 0,
        position: "relative",
        outline: selected ? "2px solid var(--canvas-selection-color)" : undefined, outlineOffset: 3,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 8, whiteSpace: "pre-wrap", overflow: "hidden",
      }}
    >
      {polygon && <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}>
        <polygon points={polygon} fill={content.fill ?? "transparent"} stroke={content.stroke ?? "#cbd5e1"}
          strokeWidth={content.strokeWidth ?? 1} vectorEffect="non-scaling-stroke" />
      </svg>}
      <span style={{ position: "relative" }}>{content.shortText}</span>
    </div>
    {selected && data.resizable && Object.entries(shapeHandles).map(([handle, label]) => <button key={handle}
      className="nodrag nopan" aria-label={"调整形状尺寸：" + label} aria-disabled={data.resizeBlocked}
      onPointerDown={event => resize.begin(event, handle as keyof typeof shapeHandles)}
      onKeyDown={event => resize.key(event, handle as keyof typeof shapeHandles)}
      onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      style={{ position: "absolute", left: handle.includes("w") ? 0 : "100%", top: handle.includes("n") ? 0 : "100%",
        transform: "translate(-50%, -50%)", width: 10, height: 10, padding: 0, border: "1px solid var(--canvas-selection-color)", background: "var(--card-color-ffffff)",
        cursor: handle === "nw" || handle === "se" ? "nwse-resize" : "nesw-resize", zIndex: 10 }} />)}
    {selected && data.editable && <ShapeTextAction anchor={anchor} edit={data.edit} appearance={data.appearance} remove={data.remove} />}
    </>
  );
}

export function shapeNodes(
  shapes: CanvasShape[], selection: string[], choose: (id: string, extend: boolean) => void, blocked: boolean,
  edit: (id: string) => void, editing: boolean, appearance: (id: string, trigger: HTMLButtonElement) => void,
  remove: (value: CanvasShape) => void,
  poses: Record<string, CanvasShape["item"]["pose"]>, geometry: ShapeResizeAPI, resizeBlocked: boolean, singleItemId: string | null,
): Node<ShapeData>[] {
  return shapes.map(value => {
    const pose = poses[value.item.id] ?? value.item.pose, disabled = blocked || geometry.pending;
    return {
    id: value.item.id,
    type: "canvasShape",
    position: { x: pose.x, y: pose.y },
    initialWidth: pose.width,
    initialHeight: pose.height,
    style: { width: pose.width, height: pose.height, pointerEvents: disabled ? "none" : undefined },
    draggable: !disabled && !editing,
    selected: selection.includes(value.item.id),
    selectable: !disabled,
    connectable: false,
    data: { value: { ...value, item: { ...value.item, pose } }, blocked: disabled, choose: extend => choose(value.item.id, extend),
      edit: () => edit(value.id), appearance: trigger => appearance(value.id, trigger), remove: () => remove(value),
      editable: singleItemId === value.item.id && !disabled && !editing, resizable: singleItemId === value.item.id && !editing, resizeBlocked: blocked || editing || resizeBlocked, geometry },
  }; });
}
