import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNearbyCanvasControls } from "./nearby-canvas-controls";
import { useViewport, type Node, type NodeProps } from "@xyflow/react";
import type { CanvasStroke } from "../../backend/src/mapping/stroke-contracts";

type StrokeData = { value: CanvasStroke; blocked: boolean; single: boolean; choose: (extend: boolean) => void; remove: () => void; annotation?: ReactNode; removeFromGroup?: (() => void) | undefined };

export function CanvasStrokeNode({ data, selected }: NodeProps<Node<StrokeData>>) {
  const { content, item } = data.value, { zoom } = useViewport();
  const anchor = useRef<HTMLDivElement>(null), toolbar = useRef<HTMLDivElement>(null);
  const showToolbar = selected && data.single && !data.blocked;
  const { positions } = useNearbyCanvasControls(anchor, toolbar, undefined, showToolbar);
  const first = content.path[0]!, label = content.penKind === "highlighter" ? "荧光笔笔迹" : "普通笔笔迹";
  const path = content.path.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" ");
  // Keep a six-CSS-pixel hit radius around thin paths at every canvas zoom.
  const hitWidth = Math.max(content.width, 12 / zoom);
  return <><div ref={anchor} role="button" aria-label={"选择" + label} aria-pressed={!!selected} aria-disabled={data.blocked}
    className="nopan" tabIndex={data.blocked ? -1 : 0}
    onClick={event => {
      event.stopPropagation();
      if (!data.blocked) { event.currentTarget.focus({ preventScroll: true }); data.choose(event.shiftKey); }
    }}
    onKeyDown={event => {
      if (data.blocked || event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault(); event.stopPropagation(); data.choose(event.shiftKey);
      }
      if (event.key === "Delete" && selected && data.single) {
        event.preventDefault(); event.stopPropagation(); data.remove();
      }
    }}
    style={{ width: "100%", height: "100%", position: "relative", pointerEvents: "none",
      outline: selected ? "2px solid var(--drawing-selection-color)" : undefined, outlineOffset: 3 }}>
    <svg role="img" aria-label={label} width="100%" height="100%" viewBox={`0 0 ${item.pose.width} ${item.pose.height}`}
      style={{ display: "block", overflow: "visible", pointerEvents: "none" }}>
      {content.path.length === 1
        ? <circle cx={first.x} cy={first.y} r={content.width / 2} fill={content.color} opacity={content.opacity} />
        : <path d={path} fill="none" stroke={content.color} strokeWidth={content.width}
          strokeLinecap="round" strokeLinejoin="round" opacity={content.opacity} />}
      {content.path.length === 1
        ? <circle aria-hidden="true" cx={first.x} cy={first.y} r={hitWidth / 2} fill="transparent"
          style={{ pointerEvents: data.blocked ? "none" : "all" }} />
        : <path aria-hidden="true" d={path} fill="none" stroke="transparent" strokeWidth={hitWidth}
          strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: data.blocked ? "none" : "stroke" }} />}
    </svg>
  </div>
  {showToolbar && createPortal(
    <div ref={toolbar} role="toolbar" aria-label="笔迹操作" className="shape-text-actions shape-text-actions--floating nodrag nopan"
      onClick={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
      style={{ ...positions?.toolbar, maxWidth: positions?.maxWidth, visibility: positions ? undefined : "hidden" }}>
      {data.annotation}
      <button onClick={data.remove}>删除笔迹</button>
      {data.removeFromGroup && <button onClick={data.removeFromGroup}>移出组合</button>}
    </div>, document.body)}
  </>;

}

export function strokeNodes(strokes: CanvasStroke[], selection: string[], choose: (id: string, extend: boolean) => void,
  remove: (value: CanvasStroke) => void, blocked: boolean, singleItemId: string | null, memberAction: (itemId: string) => (() => void) | undefined,
  annotationAction: (itemId: string) => ReactNode, canMove: (itemId: string) => boolean): Node<StrokeData>[] {
  return strokes.map(value => ({
    id: value.item.id, type: "canvasStroke", position: { x: value.item.pose.x, y: value.item.pose.y },
    initialWidth: value.item.pose.width, initialHeight: value.item.pose.height,
    style: { width: value.item.pose.width, height: value.item.pose.height, pointerEvents: "none" },
    draggable: !blocked && canMove(value.item.id), selectable: !blocked, selected: selection.includes(value.item.id), connectable: false, focusable: false,
    data: { value, blocked, single: singleItemId === value.item.id, choose: extend => choose(value.item.id, extend), remove: () => remove(value), annotation: annotationAction(value.item.id), removeFromGroup: memberAction(value.item.id) },
  }));
}
