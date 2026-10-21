import { textColors, textAlignments } from "./text-options";
import { useState, type RefObject } from "react";
import { TextToolbar } from "./text-toolbar";
import type { TextContent } from "../../backend/src/mapping/text-contracts";
import { hexColor } from "./text-runs";
export function TextObjectTools({
  anchor,
  content,
  format,
  edit,
  copy,
}: {
  anchor: RefObject<HTMLElement | null>;
  content: TextContent;
  format: (patch: Partial<TextContent>) => void;
  edit: () => void;
  copy: () => void;
}) {
  const [colors, setColors] = useState(false);
  const bold = content.runs.filter((run) => run.text).every((run) => run.bold);
  return (
    <TextToolbar anchor={anchor}>
      <button onClick={edit}>编辑文字</button>
      <button onClick={copy}>生成文字副本</button>
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
      <button
        aria-label="文字颜色"
        onClick={() => setColors((value) => !value)}
      >
        颜色
      </button>
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
      {colors && (
        <div className="text-color-panel">
          {textColors.map(({ key: color, label }) => (
            <button
              key={color}
              className={`textColor-${color}`}
              onClick={(event) => {
                const value =
                  color === "default"
                    ? undefined
                    : hexColor(getComputedStyle(event.currentTarget).color);
                format({
                  runs: content.runs.map((run) => {
                    const next = { ...run };
                    if (value) next.color = value;
                    else delete next.color;
                    return next;
                  }),
                });
                setColors(false);
              }}
            >
              {label}
              文字
            </button>
          ))}
        </div>
      )}
    </TextToolbar>
  );
}
