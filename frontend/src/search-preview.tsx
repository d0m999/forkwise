import { useLayoutEffect, useRef, useState } from "react";
import type { Card } from "./api";
import { unsupportedBlockIds } from "../../backend/src/mapping/general-blocks";
import { BodyReadingState, foldEnd } from "./body-reading-state";
import { applyListLayout, renderBlock } from "./general-block-dom";
import { animateBodyImage } from "./animated-body-image";
import {
  captureReadingAnchor,
  restoreReadingAnchor,
  type ReadingAnchor,
} from "./reading-anchor";
import {
  highlightSearch,
  scrollToSearchHit,
  searchHitIdentity,
  type SearchCard,
} from "./search-reading";

export function HitNavigation({
  count,
  hit,
  onHit,
}: {
  count: number;
  hit: number;
  onHit: (hit: number) => void;
}) {
  return count > 0 ? (
    <div className="search-navigation" aria-label="正文命中导航">
      <span aria-live="polite">
        {hit + 1} / {count}
      </span>
      <button disabled={hit <= 0} onClick={() => onHit(hit - 1)}>
        上一处
      </button>
      <button disabled={hit >= count - 1} onClick={() => onHit(hit + 1)}>
        下一处
      </button>
    </div>
  ) : null;
}
export function SearchDocument({
  projectId,
  card,
  result,
  hit,
  visible,
}: {
  projectId: string;
  card: Card;
  result: SearchCard;
  hit: number;
  visible: boolean;
}) {
  const root = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null);
  const anchor = useRef<ReadingAnchor | null>(null);
  const previousHit = useRef<string | null | undefined>(undefined);
  const [reading] = useState(
    () => new BodyReadingState(projectId + ":" + card.id),
  );
  const [foldRevision, setFoldRevision] = useState(0),
    [notice, setNotice] = useState("");
  useLayoutEffect(() => {
    if (visible) reading.refreshPreferences();
    reading.beginSearch(
      card.body.blocks,
      result.bodyHits[hit] ? [result.bodyHits[hit]!.blockId] : [],
    );
    setFoldRevision((value) => value + 1);
  }, [result.cardId, result.bodyVersion, hit, visible]);
  useLayoutEffect(() => {
    const unknown = unsupportedBlockIds(card.body.blocks);
    root.current!.replaceChildren(
      ...card.body.blocks.map((block) => {
        let node: HTMLElement;
        if (unknown.has(block.id)) {
          node = document.createElement("pre");
          node.dataset.blockId = block.id;
          node.textContent = `只读原件：${JSON.stringify(block, null, 2)}`;
        } else node = renderBlock(block, projectId);
        for (const editable of node.querySelectorAll<HTMLElement>(
          "[contenteditable]",
        )) {
          editable.contentEditable = "false";
          editable.setAttribute("aria-readonly", "true");
        }
        return node;
      }),
    );
    applyListLayout(root.current!, card.body.blocks);
    card.body.blocks.flatMap((block, index) => {
      if (foldEnd(card.body.blocks, index) <= index + 1) return [];
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.foldFor = block.id;
      button.onclick = () => {
        try {
          reading.toggle(block.id);
        } catch {
          setNotice("折叠偏好保存失败，当前阅读状态仍保留");
        }
        setFoldRevision((value) => value + 1);
      };
      const node = [...root.current!.children].find(
        (node) => (node as HTMLElement).dataset.blockId === block.id,
      )!;
      const icon = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      for (const [key, value] of Object.entries({
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
      }))
        icon.setAttribute(key, value);
      // Lucide chevron-right; the repository retains its ISC/MIT attribution.
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute("d", "m9 18 6-6-6-6");
      icon.append(path);
      button.append(icon);
      (node as HTMLElement).style.position = "relative";
      node.prepend(button);
      return [button];
    });
    const gifs = [
      ...root.current!.querySelectorAll<HTMLCanvasElement>(
        "canvas[data-gif-url]",
      ),
    ].map((canvas) => animateBodyImage(canvas, new Map()));
    if (visible) restoreReadingAnchor(scroll.current!, anchor.current);
    return () => {
      for (const gif of gifs) gif.close();
    };
  }, [card.body.versionId, projectId]);
  useLayoutEffect(() => {
    const hidden = reading.hidden(card.body.blocks);
    for (const node of root.current!.querySelectorAll<HTMLElement>(
      "[data-block-id]",
    ))
      node.hidden = hidden.has(node.dataset.blockId!);
    for (const button of root.current!.querySelectorAll<HTMLButtonElement>(
      "[data-fold-for]",
    )) {
      const block = card.body.blocks.find(
        (block) => block.id === button.dataset.foldFor,
      )!;
      button.hidden = hidden.has(block.id);
      button.setAttribute(
        "aria-label",
        `${reading.collapsed(block.id) ? "展开" : "收起"}：${block.text || "空条目"}`,
      );
      button.setAttribute(
        "aria-expanded",
        String(!reading.collapsed(block.id)),
      );
    }
  }, [foldRevision, card.body.versionId, result, hit]);
  useLayoutEffect(
    () => highlightSearch(root.current!, result, hit, "preview"),
    [result, hit, card.body.versionId],
  );
  useLayoutEffect(() => {
    if (!visible) return;
    const identity = searchHitIdentity(result, hit);
    if (previousHit.current !== identity)
      scrollToSearchHit(root.current!, scroll.current!, result, hit);
    else restoreReadingAnchor(scroll.current!, anchor.current);
    previousHit.current = identity;
  }, [result, hit, visible]);
  useLayoutEffect(() => {
    if (!visible) return;
    const observer = new ResizeObserver(() =>
      restoreReadingAnchor(scroll.current!, anchor.current),
    );
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, [visible]);
  return (
    <>
      {notice && <p role="alert">{notice}</p>}
      <div
        className="search-preview-scroll"
        ref={scroll}
        tabIndex={0}
        aria-label="只读正文滚动区域"
        onScroll={() => {
          if (visible) anchor.current = captureReadingAnchor(scroll.current!);
        }}
      >
        <div
          className="search-document paragraph-editor"
          ref={root}
          onClick={(e) => {
            if ((e.target as Element).closest("a")) e.preventDefault();
          }}
        />
      </div>
    </>
  );
}
