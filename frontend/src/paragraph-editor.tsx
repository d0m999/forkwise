import { useLayoutEffect, useRef } from "react";
import type { Block } from "../../backend/src/mapping/contracts";
import { plainParagraph } from "../../backend/src/mapping/body-text";

export type TextCursor = { start: number; end: number; blockId: string };
function cursor(editor: HTMLElement): TextCursor {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const point = range?.startContainer;
  const block = (point?.nodeType === Node.ELEMENT_NODE ? point as Element : point?.parentElement)?.closest<HTMLElement>("[data-block-id]");
  if (!range || !point || !editor.contains(point)) return { start: 0, end: 0, blockId: "" };
  const prefix = document.createRange();
  prefix.selectNodeContents(editor);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  return { start, end: start + range.toString().length, blockId: block?.dataset.blockId ?? "" };
}
function text(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeName === "BR") return "\n";
  return Array.from(node.childNodes).map(text).join("");
}
function paragraphText(element: HTMLElement): string {
  const value = text(element);
  // Chromium's final BR is a caret placeholder. A soft break at the end has
  // two BRs, so removing only the filler preserves the actual newline.
  return element.lastChild?.nodeName === "BR" ? value.slice(0, -1) : value;
}
function renderParagraph(id: string, inlineId: string, value: string) {
  const p = document.createElement("p");
  p.dataset.blockId = id;
  p.dataset.inlineId = inlineId;
  value.split("\n").forEach((line, i) => {
    if (i) p.append(document.createElement("br"));
    p.append(document.createTextNode(line));
  });
  if (!value || value.endsWith("\n")) p.append(document.createElement("br"));
  return p;
}

export function ParagraphEditor({ blocks, readOnly, onChange, onSelect, onComposition, onFinish }: {
  blocks: Block[];
  readOnly: boolean;
  onChange: (blocks: Block[], inputType: string, cursor: TextCursor) => void;
  onSelect: (cursor: TextCursor) => void;
  onComposition: (value: boolean) => void;
  onFinish: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const emitted = useRef("");
  const nativeIds = useRef(new WeakMap<Node, { id: string; inlineId: string }>());
  const selectFrame = useRef<number | undefined>(undefined);
  const supported = blocks.every(plainParagraph);
  function read(): Block[] {
    const editor = element.current!;
    const children = Array.from(editor.children).filter((e): e is HTMLElement => e instanceof HTMLElement && e.tagName !== "BR");
    if (!children.length) {
      const original = blocks[0]!;
      return [{ ...original, type: "text", text: paragraphText(editor), inlineId: original.inlineId ?? editor.dataset.inlineId! }];
    }
    const seen = new Set<string>();
    return children.map((p, i) => {
      let identity = nativeIds.current.get(p);
      if (!identity) {
        const candidate = p.dataset.blockId ?? (i === 0 ? blocks[0]!.id : "");
        const id = candidate && !seen.has(candidate) ? candidate : crypto.randomUUID();
        identity = { id, inlineId: id === candidate && p.dataset.inlineId ? p.dataset.inlineId : crypto.randomUUID() };
        nativeIds.current.set(p, identity);
      }
      // Native split copies attributes; the newly split paragraph receives its
      // own identity while the original paragraph keeps its identity.
      if (seen.has(identity.id)) {
        identity = { id: crypto.randomUUID(), inlineId: crypto.randomUUID() };
        nativeIds.current.set(p, identity);
      }
      seen.add(identity.id);
      p.dataset.blockId = identity.id;
      p.dataset.inlineId = identity.inlineId;
      return { id: identity.id, type: "text", text: paragraphText(p), inlineId: identity.inlineId };
    });
  }
  useLayoutEffect(() => {
    const editor = element.current;
    if (!editor || !supported || composing.current) return;
    if (emitted.current === JSON.stringify(blocks)) return;
    if (editor.childNodes.length) {
      const current = read();
      if (current.length === blocks.length && blocks.every((b, i) => b.id === current[i]!.id && b.text === current[i]!.text && (b.inlineId === undefined || b.inlineId === current[i]!.inlineId))) return;
    }
    editor.replaceChildren(...blocks.map((block) => {
      const p = renderParagraph(block.id, block.inlineId ?? crypto.randomUUID(), block.text!);
      nativeIds.current.set(p, { id: block.id, inlineId: p.dataset.inlineId! });
      return p;
    }));
    editor.dataset.inlineId = (editor.firstElementChild as HTMLElement)?.dataset.inlineId;
    emitted.current = JSON.stringify(blocks);
  }, [blocks, supported]);
  useLayoutEffect(() => {
    if (readOnly && element.current?.contains(document.activeElement)) {
      element.current.blur();
      window.getSelection()?.removeAllRanges();
    }
  }, [readOnly]);
  if (!supported) return (
    <section className="original-body" aria-label="只读正文原件">
      <p>此正文包含尚不支持的内容，原件只读保留。</p>
      {blocks.map((block) => <section key={block.id} data-block-id={block.id}>
        <h3>原件：{block.type}</h3>
        <pre>{plainParagraph(block) ? block.text : JSON.stringify(block, null, 2)}</pre>
      </section>)}
    </section>
  );
  return <div
    id="card-body"
    className="paragraph-editor"
    ref={element}
    role="textbox"
    aria-label="卡片正文"
    aria-multiline="true"
    aria-readonly={readOnly}
    contentEditable={!readOnly}
    suppressContentEditableWarning
    onFocus={() => document.execCommand("defaultParagraphSeparator", false, "p")}
    onInput={(event) => {
      if (selectFrame.current !== undefined) cancelAnimationFrame(selectFrame.current);
      const next = read();
      emitted.current = JSON.stringify(next);
      onChange(next, (event.nativeEvent as InputEvent).inputType, cursor(event.currentTarget));
    }}
    onSelect={() => {
      if (selectFrame.current !== undefined) cancelAnimationFrame(selectFrame.current);
      selectFrame.current = requestAnimationFrame(() => { if (!composing.current && element.current) onSelect(cursor(element.current)); });
    }}
    onKeyUp={event => { if (!composing.current) onSelect(cursor(event.currentTarget)); }}
    onPointerUp={event => { if (!composing.current) onSelect(cursor(event.currentTarget)); }}
    onCompositionStart={() => { composing.current = true; onComposition(true); }}
    onCompositionEnd={() => { composing.current = false; onComposition(false); }}
    onBlur={onFinish}
    onPaste={(event) => {
      // Complex rich paste belongs to #14. The basic editor accepts literal
      // text without interpreting imported HTML, Markdown or scripts.
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    }}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
      if (event.key === "Backspace" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        const node = range?.startContainer;
        const current = (node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement)?.closest<HTMLElement>("p[data-block-id]");
        if (range?.collapsed && current && current.parentElement === event.currentTarget) {
          const prefix = document.createRange();
          prefix.selectNodeContents(current);
          prefix.setEnd(range.startContainer, range.startOffset);
          const previous = current.previousElementSibling as HTMLElement | null;
          if (!prefix.toString() && previous) {
            event.preventDefault();
            if (!previous.matches("p[data-block-id]")) return;
            const before = paragraphText(previous);
            const merged = renderParagraph(previous.dataset.blockId!, previous.dataset.inlineId!, before + paragraphText(current));
            const replacement = document.createRange();
            replacement.setStart(previous, 0);
            replacement.setEnd(current, current.childNodes.length);
            selection!.removeAllRanges();
            selection!.addRange(replacement);
            // Native insertHTML keeps this structural edit in the browser text
            // undo buffer. No separate project-history command is dispatched.
            document.execCommand("insertHTML", false, merged.innerHTML);
            const inserted = Array.from(event.currentTarget.children).find(p => (p as HTMLElement).dataset.blockId === merged.dataset.blockId);
            if (inserted) {
              const walker = document.createTreeWalker(inserted, NodeFilter.SHOW_TEXT);
              let left = before.length, point = walker.nextNode();
              while (point && left > (point.textContent?.length ?? 0)) { left -= point.textContent?.length ?? 0; point = walker.nextNode(); }
              if (point) selection!.collapse(point, Math.min(left, point.textContent?.length ?? 0));
            }
          }
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        event.currentTarget.blur();
      }
    }}
  />;
}
