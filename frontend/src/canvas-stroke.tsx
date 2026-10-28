import { useViewport, type Node, type NodeProps } from "@xyflow/react";
import type { CanvasStroke } from "../../backend/src/mapping/stroke-contracts";

type StrokeData = { value: CanvasStroke; blocked: boolean; single: boolean; choose: (extend: boolean) => void; remove: () => void; removeFromGroup?: (() => void) | undefined };

export function CanvasStrokeNode({ data, selected }: NodeProps<Node<StrokeData>>) {
  const { content, item } = data.value, { zoom } = useViewport();
  const first = content.path[0]!, label = content.penKind === "highlighter" ? "荧光笔笔迹" : "普通笔笔迹";
  const path = content.path.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" ");
  // Keep a six-CSS-pixel hit radius around thin paths at every canvas zoom.
  const hitWidth = Math.max(content.width, 12 / zoom);
  return <div role="button" aria-label={"选择" + label} aria-pressed={!!selected} aria-disabled={data.blocked}
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
      outline: selected ? "2px solid var(--canvas-selection-color)" : undefined, outlineOffset: 3 }}>
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
    {selected && data.single && !data.blocked && <button className="nodrag nopan" aria-label="删除笔迹"
      style={{ position: "absolute", left: 0, top: "calc(100% + 8px)", whiteSpace: "nowrap", pointerEvents: "auto" }}
      onMouseDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); data.remove(); }}>删除笔迹</button>}
    {selected && data.single && !data.blocked && data.removeFromGroup && <button className="nodrag nopan" aria-label="移出组合"
      style={{ position: "absolute", left: 90, top: "calc(100% + 8px)", whiteSpace: "nowrap", pointerEvents: "auto" }}
      onMouseDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); data.removeFromGroup!(); }}>移出组合</button>}
  </div>;
}

export function strokeNodes(strokes: CanvasStroke[], selection: string[], choose: (id: string, extend: boolean) => void,
  remove: (value: CanvasStroke) => void, blocked: boolean, singleItemId: string | null, memberAction: (itemId: string) => (() => void) | undefined): Node<StrokeData>[] {
  return strokes.map(value => ({
    id: value.item.id, type: "canvasStroke", position: { x: value.item.pose.x, y: value.item.pose.y },
    initialWidth: value.item.pose.width, initialHeight: value.item.pose.height,
    style: { width: value.item.pose.width, height: value.item.pose.height, pointerEvents: "none" },
    draggable: !blocked, selectable: !blocked, selected: selection.includes(value.item.id), connectable: false, focusable: false,
    data: { value, blocked, single: singleItemId === value.item.id, choose: extend => choose(value.item.id, extend), remove: () => remove(value), removeFromGroup: memberAction(value.item.id) },
  }));
}
