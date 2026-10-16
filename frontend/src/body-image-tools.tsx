import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Block } from "../../backend/src/mapping/contracts";

export function BodyImageTools({
  block,
  node,
  onChange,
  onComposition,
}: {
  block: Block;
  node: HTMLElement;
  onChange: (next: Block) => void;
  onComposition: (value: boolean) => void;
}) {
  const image = node.querySelector<HTMLImageElement | HTMLCanvasElement>(
    "canvas, img",
  )!;
  const [width, setWidth] = useState(image.getBoundingClientRect().width);
  const grip = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: 0, top: 0 });
  const drag = useRef<{
    pointer: number;
    x: number;
    width: number;
    value: number;
    style: string;
  } | null>(null);
  const [details, setDetails] = useState<{
    caption: string;
    alt: string;
  } | null>(null);
  const composing = useRef(false);
  function measure() {
    setWidth(image.getBoundingClientRect().width);
    const box = image.getBoundingClientRect(),
      parent = (
        grip.current?.offsetParent as HTMLElement | null
      )?.getBoundingClientRect();
    if (!parent) return;
    const next = {
      left: box.right - parent.left,
      top: box.top - parent.top + box.height / 2,
    };
    setEdge((old) =>
      old.left === next.left && old.top === next.top ? old : next,
    );
  }
  useLayoutEffect(measure);
  const cancel = () => {
    if (!drag.current) return;
    image.style.width = drag.current.style;
    drag.current = null;
    setWidth(image.getBoundingClientRect().width);
  };
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    observer.observe(image);
    observer.observe(node.closest(".general-editor")!);
    const scroller = node.closest(".board-scroll");
    scroller?.addEventListener("scroll", measure);
    window.addEventListener("blur", cancel);
    return () => {
      observer.disconnect();
      scroller?.removeEventListener("scroll", measure);
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, [image]);
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setDetails({
            caption: String(block.caption ?? ""),
            alt: String(block.alt ?? ""),
          })
        }
      >
        编辑图片说明
      </button>
      {details && (
        <div
          className="body-image-details"
          role="group"
          aria-label="图片说明"
          onCompositionStart={() => {
            composing.current = true;
            onComposition(true);
          }}
          onCompositionEnd={() => {
            composing.current = false;
            onComposition(false);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (
              e.nativeEvent.isComposing ||
              composing.current ||
              e.keyCode === 229
            )
              return;
            if (e.key === "Escape") {
              e.preventDefault();
              setDetails(null);
              node.focus({ preventScroll: true });
            }
          }}
        >
          <label>
            图注
            <textarea
              aria-label="图注"
              value={details.caption}
              onChange={(e) =>
                setDetails({ ...details, caption: e.target.value })
              }
            />
          </label>
          <label>
            替代文字
            <input
              aria-label="替代文字"
              value={details.alt}
              onChange={(e) => setDetails({ ...details, alt: e.target.value })}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              if (composing.current) return;
              const { caption: _caption, alt: _alt, ...original } = block;
              onChange({
                ...original,
                ...(details.caption ? { caption: details.caption } : {}),
                ...(details.alt ? { alt: details.alt } : {}),
              });
              setDetails(null);
            }}
          >
            保存图片说明
          </button>
          <button
            type="button"
            onClick={() => {
              if (!composing.current) {
                setDetails(null);
                node.focus({ preventScroll: true });
              }
            }}
          >
            取消图片说明
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          if (block.width === undefined) return;
          const { width: _width, ...automatic } = block;
          onChange(automatic);
        }}
      >
        自动适应
      </button>
      {createPortal(
        <div
          ref={grip}
          className="body-image-grip"
          role="slider"
          aria-label="调整正文图片宽度"
          aria-valuemin={1}
          aria-valuemax={40000000}
          aria-valuenow={Math.round(Number(block.width ?? width))}
          aria-orientation="horizontal"
          tabIndex={0}
          style={edge}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.focus({ preventScroll: true });
            drag.current = {
              pointer: e.pointerId,
              x: e.clientX,
              width,
              value: width,
              style: image.style.width,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const current = drag.current;
            if (!current || current.pointer !== e.pointerId) return;
            current.value = Math.max(
              1,
              Math.min(40000000, current.width + e.clientX - current.x),
            );
            image.style.width = `${current.value}px`;
            setWidth(image.getBoundingClientRect().width);
          }}
          onPointerUp={(e) => {
            const current = drag.current;
            if (!current || current.pointer !== e.pointerId) return;
            image.style.width = current.style;
            drag.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
            if (current.value !== current.width)
              onChange({ ...block, width: current.value });
          }}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
            if (["ArrowLeft", "ArrowRight", "Home"].includes(e.key)) {
              e.preventDefault();
              e.stopPropagation();
              const next =
                e.key === "Home"
                  ? 1
                  : Math.max(
                      1,
                      Math.min(
                        40000000,
                        Math.round(Number(block.width ?? width)) +
                          (e.key === "ArrowLeft" ? -20 : 20),
                      ),
                    );
              if (next !== block.width) onChange({ ...block, width: next });
            }
          }}
        />,
        node.closest(".general-editor")!,
      )}
    </>
  );
}
