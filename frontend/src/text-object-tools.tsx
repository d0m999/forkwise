import { textAlignments } from "./text-options";
import { useState, type ReactNode, type RefObject } from "react";
import { TextToolbar } from "./text-toolbar";
import type { TextContent } from "../../backend/src/mapping/text-contracts";
import { TextColorPicker } from "./text-color-picker";
import { LayerMenu, type LayerMenuProps } from "./layer-menu";
export function TextObjectTools({
  anchor,
  content,
  format,
  edit,
  copy,
  remove,
  removeFromGroup,
  layer,
  annotation,
}: {
  anchor: RefObject<HTMLElement | null>;
  content: TextContent;
  format: (patch: Partial<TextContent>) => void;
  edit: () => void;
  copy: () => void;
  remove?: (() => void) | undefined;
  removeFromGroup?: (() => void) | undefined;
  annotation?: ReactNode;
  layer?: LayerMenuProps | undefined;
}) {
  const [colors, setColors] = useState(false);
  const bold = content.runs.filter((run) => run.text).every((run) => run.bold);
  return (
    <TextToolbar anchor={anchor}>
      <button onClick={edit}>编辑文字</button>
      <button onClick={copy}>生成文字副本</button>
      {annotation}
      {layer && <LayerMenu {...layer} />}
      {remove && <button onClick={event => { event.stopPropagation(); remove(); }}>删除文字</button>}
      {removeFromGroup && <button onClick={event => { event.stopPropagation(); removeFromGroup(); }}>移出组合</button>}
      <button
        aria-label="加粗文字"
        aria-pressed={bold}
        onClick={() =>
          format({
            runs: content.runs.map((run) => {
              const next = { ...run };
              if (bold) delete next.bold;
              else next.bold = true;
              return next;
            }),
          })
        }
      >
        B
      </button>
      <TextColorPicker open={colors} setOpen={setColors} apply={color => format({
        runs: content.runs.map(run => {
          const next = { ...run };
          if (color) next.color = color;
          else delete next.color;
          return next;
        }),
      })} />
      <label>
        字号
        <input
          type="number"
          aria-label="文字字号"
          min="1"
          value={content.fontSize}
          onChange={(event) => {
            const size = Number(event.target.value);
            if (size > 0) format({ fontSize: size });
          }}
        />
      </label>
      {textAlignments.map(({ value: align, label, aria }) => (
        <button
          key={align}
          aria-label={`文字${aria}`}
          aria-pressed={content.align === align}
          onClick={() => format({ align })}
        >
          {label}
        </button>
      ))}
    </TextToolbar>
  );
}
