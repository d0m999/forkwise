import { textColors, textAlignments } from "./text-options";
import { TextToolbar } from "./text-toolbar";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TextContent } from "../../backend/src/mapping/text-contracts";
import {
  readTextRuns,
  renderTextRuns,
  hexColor,
  textRange,
  sliceRuns,
  selectTextRange,
} from "./text-runs";
export function TextEditor({
  content,
  change,
  finish,
  compose,
}: {
  content: TextContent;
  change: (value: TextContent) => void;
  finish: () => void;
  compose: (active: boolean, content?: TextContent) => void;
}) {
  const editor = useRef<HTMLDivElement>(null),
    range = useRef<Range | null>(null);
  const [bold, setBold] = useState(false),
    [colors, setColors] = useState(false);
  const [color, setColor] = useState<string | undefined>();
  const composing = useRef(false);
  const latest = useRef(content);
  latest.current = content;
  const emit = () =>
    change({ ...latest.current, runs: readTextRuns(editor.current!) });
  function sync() {
    const selection = window.getSelection();
    if (
      !selection?.rangeCount ||
      !editor.current?.contains(selection.anchorNode)
    )
      return;
    range.current = selection.getRangeAt(0).cloneRange();
    const position = textRange(editor.current!, range.current);
    const runs = sliceRuns(
      readTextRuns(editor.current!),
      position.start,
      position.end,
    );
    setBold(
      runs.length
        ? runs.every((run) => run.bold)
        : document.queryCommandState("bold"),
    );
    setColor(
      runs.length
        ? runs.every((run) => run.color === runs[0]?.color)
          ? runs[0]?.color
          : undefined
        : hexColor(document.queryCommandValue("foreColor")),
    );
  }
  useLayoutEffect(() => {
    renderTextRuns(editor.current!, content.runs);
    editor.current!.focus();
    const selection = window.getSelection(),
      next = document.createRange();
    next.selectNodeContents(editor.current!);
    next.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(next);
    sync();
  }, []);
  useEffect(() => {
    document.addEventListener("selectionchange", sync);
    return () => document.removeEventListener("selectionchange", sync);
  }, []);
  useEffect(() => {
    if (!colors) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || composing.current || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); event.stopImmediatePropagation(); setColors(false);
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [colors]);
  function restore() {
    editor.current!.focus();
    if (range.current) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range.current);
    }
  }
  function format(command: string, value?: string) {
    restore();
    const position = range.current
      ? textRange(editor.current!, range.current)
      : { start: 0, end: 0 };
    if (position.end > position.start) {
      const runs = sliceRuns(
        readTextRuns(editor.current!),
        position.start,
        position.end,
      ).map((run) => {
        const next = { ...run };
        if (command === "bold") {
          if (bold) delete next.bold;
          else next.bold = true;
        } else if (
          value &&
          value !== hexColor(getComputedStyle(editor.current!).color)
        )
          next.color = value;
        else delete next.color;
        return next;
      });
      const fragment = document.createElement("div");
      renderTextRuns(fragment, runs);
      document.execCommand("insertHTML", false, fragment.innerHTML);
      selectTextRange(editor.current!, position.start, position.end);
    } else {
      document.execCommand("styleWithCSS", false, "true");
      const desiredBold = command === "bold" ? !bold : bold;
      if (document.queryCommandState("bold") !== desiredBold)
        document.execCommand("bold");
      const desiredColor = command === "foreColor" ? value : color;
      if (desiredColor) document.execCommand("foreColor", false, desiredColor);
    }
    emit();
    sync();
    setColors(false);
  }
  return (
    <>
      <TextToolbar anchor={editor} preserveSelection>
        <button
          aria-label="加粗文字"
          aria-pressed={bold}
          onClick={() => format("bold")}
        >
          B
        </button>
        <button
          aria-label="文字颜色"
          style={{ color }}
          onClick={() => setColors((value) => !value)}
        >
          颜色
        </button>
        <label>
          字号
          <input
            type="number"
            aria-label="文字字号"
            value={content.fontSize}
            min="1"
            onChange={(event) => {
              const size = Number(event.target.value);
              if (size > 0) change({ ...latest.current, fontSize: size });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                restore();
              }
            }}
          />
        </label>
        {textAlignments.map(({ value: align, label, aria }) => (
          <button
            key={align}
            aria-label={`文字${aria}`}
            aria-pressed={content.align === align}
            onClick={() => change({ ...latest.current, align })}
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
                onClick={(event) =>
                  format(
                    "foreColor",
                    hexColor(
                      color === "default"
                        ? getComputedStyle(editor.current!).color
                        : getComputedStyle(event.currentTarget).color,
                    ),
                  )
                }
              >
                {label}
                文字
              </button>
            ))}
          </div>
        )}
      </TextToolbar>
      <div
        ref={editor}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label="独立文字"
        aria-multiline="true"
        className="canvas-text-input nodrag nopan nowheel"
        onCompositionStart={() => {
          composing.current = true;
          compose(true);
        }}
        onCompositionEnd={() => {
          composing.current = false;
          compose(false, {
            ...latest.current,
            runs: readTextRuns(editor.current!),
          });
        }}
        onInput={emit}
        onKeyUp={sync}
        onMouseUp={sync}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const plain = event.dataTransfer.getData("text/plain");
          if (!plain) return;
          const target = document.caretRangeFromPoint(
            event.clientX,
            event.clientY,
          );
          editor.current!.focus();
          if (target && editor.current!.contains(target.startContainer)) {
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(target);
          }
          document.execCommand("insertText", false, plain);
          emit();
        }}
        onPaste={(event) => {
          event.preventDefault();
          document.execCommand(
            "insertText",
            false,
            event.clipboardData.getData("text/plain"),
          );
          emit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish();
            return;
          }
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          )
            return;
          if (event.key === "Enter") {
            event.preventDefault();
            document.execCommand("insertLineBreak");
            emit();
          }
        }}
      />
    </>
  );
}
