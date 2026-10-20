import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  SearchConditions,
  SearchStateView,
} from "../../backend/src/mapping/search-contracts";
import type { useSearchRecords } from "./search-records";
import type { Tag } from "../../backend/src/mapping/contracts";
import { TagChip } from "./project-tags";

export function SearchHistory({
  open,
  visible,
  trigger,
  records,
  query,
  tags,
  onToggle,
  onRestore,
}: {
  open: boolean;
  visible: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  records: ReturnType<typeof useSearchRecords>;
  query: SearchConditions;
  tags: Tag[];
  onToggle: () => void;
  onRestore: (query: SearchConditions) => void;
}) {
  const [notice, setNotice] = useState<{ id: string; label: string } | null>(
    null,
  );
  const [hovered, setHovered] = useState(false),
    [focused, setFocused] = useState(false);
  const remaining = useRef(8000);
  const timedNotice = useRef<string | null>(null);
  const paused = visible && (hovered || focused);
  const list = useRef<HTMLElement>(null);
  const noticeElement = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = visible ? noticeElement.current : null;
    setHovered(element?.matches(":hover") ?? false);
    setFocused(element?.contains(document.activeElement) ?? false);
  }, [notice?.id, visible]);
  useLayoutEffect(() => {
    const popup = list.current,
      button = trigger.current;
    const dialog = button?.closest("dialog");
    if (!open || !visible || !popup || !button || !dialog) return;
    const anchorRoot = button.parentElement ?? button;
    const position = () => {
      const bounds = dialog.getBoundingClientRect(),
        anchor = anchorRoot.getBoundingClientRect();
      const padding = getComputedStyle(dialog);
      const left = Math.max(
        0,
        bounds.left + dialog.clientLeft + parseFloat(padding.paddingLeft),
      );
      const right = Math.min(
        window.innerWidth,
        bounds.right - dialog.clientLeft - parseFloat(padding.paddingRight),
      );
      const top = Math.max(
        0,
        bounds.top + dialog.clientTop + parseFloat(padding.paddingTop),
      );
      const bottom = Math.min(
        window.innerHeight,
        bounds.bottom - dialog.clientTop - parseFloat(padding.paddingBottom),
      );
      popup.style.maxWidth = `${Math.max(0, right - left)}px`;
      popup.style.maxHeight = `min(var(--search-popover-height), 45vh, ${Math.max(0, bottom - top)}px)`;
      const below = Math.max(0, bottom - Math.max(top, anchor.bottom));
      const above = Math.max(0, Math.min(bottom, anchor.top) - top);
      const preferBelow =
        popup.getBoundingClientRect().height <= below || below >= above;
      popup.style.maxHeight = `min(var(--search-popover-height), 45vh, ${preferBelow ? below : above}px)`;
      const size = popup.getBoundingClientRect();
      popup.style.left = `${Math.max(left, Math.min(anchor.left, right - size.width))}px`;
      popup.style.top = `${preferBelow ? Math.max(top, anchor.bottom) : Math.min(bottom, anchor.top) - size.height}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(dialog);
    observer.observe(popup);
    observer.observe(anchorRoot);
    const row = button.closest(".search-tags");
    if (row) observer.observe(row);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, visible, tags, query.tagIds, records.state?.history]);
  useEffect(() => {
    if (!notice) return;
    if (timedNotice.current !== notice.id) {
      timedNotice.current = notice.id;
      remaining.current = 8000;
    }
    if (paused) return;
    const started = performance.now();
    const timer = window.setTimeout(() => setNotice(null), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(
        0,
        remaining.current - (performance.now() - started),
      );
    };
  }, [notice, paused]);
  const remove = (entry?: SearchStateView["history"][number]) => {
    const id = records.write(
      entry
        ? { type: "search.delete", payload: { query, id: entry.id } }
        : { type: "search.clear", payload: { query } },
    );
    setNotice({ id, label: entry ? "已删除历史" : "已清空搜索历史" });
  };
  return (
    <div className="search-history">
      <button
        ref={trigger}
        aria-label="搜索历史"
        aria-expanded={open}
        onClick={onToggle}
      >
        历史
      </button>
      {open && (
        <section
          ref={list}
          aria-label="最近搜索历史"
          className="search-history-list"
        >
          <div className="search-history-heading">
            <strong>最近搜索</strong>
            <button
              disabled={!records.state?.history.length}
              onClick={() => remove()}
            >
              清空全部历史
            </button>
          </div>
          {!records.state?.history.length && <p>还没有搜索历史</p>}
          {records.state?.history.map((entry) => {
            const label = [
              entry.query.text,
              ...entry.query.tagIds.map((id) => {
                const tag = tags.find((tag) => tag.id === id);
                return `${tag?.name ?? id}${tag?.deleted ? "（已删除）" : ""}`;
              }),
            ]
              .filter(Boolean)
              .join("＋");
            return (
              <div key={entry.id} className="search-history-entry">
                <button
                  aria-label={`恢复搜索 ${label}`}
                  onClick={() => onRestore(entry.query)}
                >
                  <span>{entry.query.text || "仅标签查询"}</span>
                  <span className="search-history-tags">
                    {entry.query.tagIds.map((id) => {
                      const tag = tags.find((tag) => tag.id === id);
                      return tag && !tag.deleted ? (
                        <TagChip key={id} tag={tag} />
                      ) : (
                        <span key={id}>{tag?.name ?? id}（已删除）</span>
                      );
                    })}
                  </span>
                  <time dateTime={entry.usedAt}>
                    {new Date(entry.usedAt).toLocaleString("zh-CN")}
                  </time>
                </button>
                <button
                  aria-label={`删除历史 ${label}`}
                  onClick={() => remove(entry)}
                >
                  删除
                </button>
              </div>
            );
          })}
          <button onClick={onToggle}>完成历史选择</button>
        </section>
      )}
      {notice && (
        <div
          ref={noticeElement}
          className="search-history-notice"
          role="alert"
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              setFocused(false);
          }}
        >
          <span>{notice.label}</span>
          <button
            aria-label="撤销历史清理"
            onClick={() => {
              records.write({
                type: "search.restore",
                payload: { undoId: notice.id },
              });
              setNotice(null);
            }}
          >
            撤销
          </button>
        </div>
      )}
    </div>
  );
}
