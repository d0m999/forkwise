import { useLayoutEffect, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { TextObjectTools } from "./text-object-tools";
import { TextEditor } from "./text-editor";
import { textHandles, textMinimumWidth, useTextGeometry } from "./text-geometry";
import type { Node, NodeProps } from "@xyflow/react";
import type {
  CanvasText,
  TextContent,
} from "../../backend/src/mapping/text-contracts";
export type TextData = {
  value: CanvasText;
  editing: boolean;
  ending: boolean;
  measurable: boolean;
  singleSelection: boolean;
  measure: (width: number, height: number) => void;
  change: (content: TextContent) => void;
  format: (patch: Partial<TextContent>) => void;
  finish: () => void;
  edit: () => void;
  copy: () => void;
  remove?: (() => void) | undefined;
  removeFromGroup?: (() => void) | undefined;
  transform: (next: CanvasText, origin: CanvasText) => void;
  compose: (active: boolean, content?: TextContent) => void;
  moveDisabled: boolean;
  move: (dx: number, dy: number) => void;
  focus: () => void;
};
export function CanvasTextNode({ data, selected }: NodeProps<Node<TextData>>) {
  const element = useRef<HTMLElement>(null),
    layout = useRef<HTMLDivElement>(null),
    flow = useReactFlow();
  const [size, setSize] = useState({
    width: data.value.item.pose.width,
    height: data.value.item.pose.height,
  });
  const geometry = useTextGeometry(
    data.value,
    element,
    () => flow.getZoom(),
    data.transform,
  );
  const content = (geometry.preview ?? data.value).content;
  const fontScale = content.fontSize / 18;
  useLayoutEffect(() => {
    const measure = () => {
      const bounds = layout.current!.getBoundingClientRect();
      const next = {
        width: bounds.width / flow.getZoom(),
        height: bounds.height / flow.getZoom(),
      };
      setSize((current) =>
        Math.abs(current.width - next.width) < 0.001 &&
        Math.abs(current.height - next.height) < 0.001 ? current : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout.current!);
    return () => observer.disconnect();
  }, [JSON.stringify(content), data.editing, data.ending]);
  useLayoutEffect(() => {
    if (geometry.preview || !data.measurable) return;
    const measure = () => {
      const bounds = element.current!.getBoundingClientRect();
      const rendered = layout.current!.getBoundingClientRect();
      // A content change updates the inner layout before its measured outer
      // frame. Never persist the previous frame as this content's new Pose.
      // Cover CSS 1/64px layout rounding, not a content or gesture change.
      const tolerance = 0.02 * flow.getZoom();
      if (
        Math.abs(bounds.height - rendered.height) > tolerance ||
        (content.widthMode === "auto" && Math.abs(bounds.width - rendered.width) > tolerance)
      ) return;
      data.measure(
        bounds.width / flow.getZoom(),
        bounds.height / flow.getZoom(),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element.current!);
    return () => observer.disconnect();
  }, [
    data.value.versionId,
    data.value.item.versionId,
    JSON.stringify(content),
    data.editing,
    data.measurable,
    geometry.preview,
  ]);
  return (
    <article
      ref={element}
      className="canvas-text"
      style={{
        transform: geometry.preview
          ? `translate(${geometry.preview.item.pose.x - data.value.item.pose.x}px, ${geometry.preview.item.pose.y - data.value.item.pose.y}px)`
          : undefined,
        width: content.widthMode === "fixed" ? content.width : size.width,
        height: size.height,
        minWidth: textMinimumWidth(content.fontSize),
        fontSize: content.fontSize,
        lineHeight: content.lineHeight,
        textAlign: content.align,
      }}
    >
      {selected && data.singleSelection && !data.editing && (
        <TextObjectTools
          anchor={element}
          content={content}
          format={data.format}
          edit={data.edit}
          copy={data.copy}
          remove={data.remove}
          removeFromGroup={data.removeFromGroup}
        />
      )}
      {selected &&
        data.singleSelection &&
        !data.editing &&
        Object.entries(textHandles).map(([handle, label]) => (
          <button
            key={handle}
            className={`text-resize text-resize-${handle} nodrag nopan`}
            aria-label={`调整文字尺寸：${label}`}
            title="方向键调整，Shift 加快"
            onKeyDown={(event) =>
              geometry.key(event, handle as keyof typeof textHandles)
            }
            onPointerDown={(event) =>
              geometry.begin(event, handle as keyof typeof textHandles)
            }
          />
        ))}
      <div
        ref={layout}
        style={{
          // Keep shaping and wrapping at one font size; corner scaling then
          // changes the whole rendered box without asking fonts to reflow.
          fontSize: 18,
          width: content.widthMode === "auto" ? "max-content" : content.width / fontScale,
          maxWidth: content.widthMode === "auto" ? content.width / fontScale : undefined,
          minWidth: textMinimumWidth(18),
          transform: `scale(${fontScale})`,
          transformOrigin: "0 0",
        }}
      >
      {data.editing && !data.ending ? (
        <TextEditor
          content={content}
          change={data.change}
          finish={data.finish}
          compose={data.compose}
        />
      ) : (
        <div
          className="canvas-text-content"
          role="group"
          aria-label="独立文字：方向键调整位置，Enter编辑"
          aria-disabled={data.moveDisabled}
          tabIndex={0}
          onDoubleClick={data.edit}
          onKeyDown={(event) => {
            if (data.moveDisabled || event.nativeEvent.isComposing || event.keyCode === 229) return;
            const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
            if (delta || event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              data.focus();
              if (delta) data.move(delta[0]!, delta[1]!);
              else data.edit();
            }
          }}
        >
          {content.runs.map((run, index) => (
            <span
              key={index}
              style={{ fontWeight: run.bold ? 700 : 400, color: run.color }}
            >
              {run.text}
            </span>
          ))}
        </div>
      )}
      </div>
    </article>
  );
}
