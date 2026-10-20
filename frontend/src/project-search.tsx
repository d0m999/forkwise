import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type Card } from "./api";
import { searchHitIdentity, type SearchReading } from "./search-reading";
import { SearchDocument, HitNavigation } from "./search-preview";
import type { Tag } from "../../backend/src/mapping/contracts";
import { cardTags, compareTagNames, TagChip } from "./project-tags";
import type {
  SearchRange,
  SearchResult,
} from "../../backend/src/mapping/search-contracts";

type Result = SearchResult["results"][number];
function Highlight({
  text,
  ranges,
  start = 0,
  end = text.length,
}: {
  text: string;
  ranges: SearchRange[];
  start?: number;
  end?: number;
}) {
  let cursor = start;
  const parts = ranges
    .filter((hit) => hit.end > start && hit.start < end)
    .map((hit, index) => {
      const before = text.slice(cursor, Math.max(start, hit.start));
      cursor = Math.min(end, hit.end);
      return (
        <Fragment key={index}>
          {before}
          <mark>{text.slice(Math.max(start, hit.start), cursor)}</mark>
        </Fragment>
      );
    });
  return (
    <>
      {start > 0 && "…"}
      {parts}
      {text.slice(cursor, end)}
      {end < text.length && "…"}
    </>
  );
}
function Snippet({ result }: { result: Result }) {
  const first = result.bodyHits[0];
  const index =
    first?.segment ??
    result.segments.findIndex((segment) => segment.text.length > 0);
  const segment = result.segments[index];
  if (!segment) return null;
  let start = Math.max(0, (first?.start ?? 0) - 24);
  if (/[\uDC00-\uDFFF]/u.test(segment.text[start] ?? "")) start--;
  let end = Math.min(
    segment.text.length,
    Math.max(start + 180, first?.end ?? 0),
  );
  if (/[\uDC00-\uDFFF]/u.test(segment.text[end] ?? "")) end--;
  return (
    <p className="search-snippet">
      <Highlight
        text={segment.text}
        start={start}
        end={end}
        ranges={result.bodyHits.filter((hit) => hit.segment === index)}
      />
    </p>
  );
}

function SearchThumbnail({
  projectId,
  image,
}: {
  projectId: string;
  image: Card["body"]["blocks"][number];
}) {
  const [failed, setFailed] = useState(false),
    [attempt, setAttempt] = useState(0);
  return (
    <span className="search-thumbnail-area">
      <img
        key={attempt}
        className="search-thumbnail"
        src={`/api/mapping/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(String(image.assetId))}/content`}
        alt={String(image.alt || image.name || "正文图片")}
        onError={() => setFailed(true)}
        onLoad={() => setFailed(false)}
      />
      {failed && (
        <span role="alert">
          <span>缩略图加载失败</span>
          <button
            onClick={(event) => {
              event.stopPropagation();
              setAttempt((value) => value + 1);
            }}
          >
            重新加载缩略图
          </button>
        </span>
      )}
    </span>
  );
}

export function ProjectSearch({
  projectId,
  revision,
  disabled,
  tags,
  cards,
  onOpen,
}: {
  projectId: string;
  revision: number;
  disabled: boolean;
  tags: Tag[];
  cards: Card[];
  onOpen: (reading: SearchReading, valid: () => boolean) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false),
    [text, setText] = useState("");
  const [composing, setComposing] = useState(false),
    [literal, setLiteral] = useState(false);
  const [attempt, setAttempt] = useState(0),
    [explain, setExplain] = useState(false);
  const [result, setResult] = useState<SearchResult>(),
    [error, setError] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]),
    [tagQuery, setTagQuery] = useState(""),
    [picker, setPicker] = useState(false);
  const tagTrigger = useRef<HTMLButtonElement>(null),
    explanationTrigger = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState<string>(),
    [hit, setHit] = useState(0),
    [previewPage, setPreviewPage] = useState(false);
  const [opening, setOpening] = useState(false);
  const currentSelection = useRef({ selected, hit, result });
  currentSelection.current = { selected, hit, result };
  const outsideDown = useRef(false),
    navigation = useRef(0);
  const [narrow, setNarrow] = useState(false);
  const previousNarrow = useRef<boolean | null>(null);
  const content = useRef<HTMLDivElement>(null),
    previousQuery = useRef("");
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const composition = useRef(false),
    generation = useRef(0),
    delay = useRef(200),
    retry = useRef(false);
  const invalidate = () => {
    generation.current++;
    setPending(true);
    setError("");
    setExplain(false);
  };
  const close = (returnFocus = true) => {
    if (!composition.current) {
      setPicker(false);
      setExplain(false);
      generation.current++;
      dialog.current?.close();
      setOpen(false);
      if (returnFocus) trigger.current?.focus();
    }
  };
  useLayoutEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    input.current?.focus();
    input.current?.setSelectionRange(text.length, text.length);
    return () => dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (!open || composing) return;
    const current = ++generation.current;
    setPending(true);
    setError("");
    const retryLibrary = retry.current;
    retry.current = false;
    const timer = window.setTimeout(async () => {
      try {
        const value = await api.search(projectId, {
          text,
          tagIds,
          literal,
          retry: retryLibrary,
        });
        if (current === generation.current) {
          const previous = currentSelection.current;
          const next =
            value.results.find((card) => card.cardId === previous.selected)
              ?.cardId ?? value.results[0]?.cardId;
          let nextHit = 0;
          if (next === previous.selected && previousQuery.current === text) {
            const old = previous.result?.results.find(
              (card) => card.cardId === next,
            );
            const updated = value.results.find((card) => card.cardId === next);
            const identity = old && searchHitIdentity(old, previous.hit);
            const same =
              identity && updated
                ? updated.bodyHits.findIndex(
                    (_, index) =>
                      searchHitIdentity(updated, index) === identity,
                  )
                : -1;
            nextHit =
              same >= 0
                ? same
                : Math.min(
                    previous.hit,
                    Math.max(0, (updated?.bodyHits.length ?? 0) - 1),
                  );
          }
          setResult(value);
          setSelected(next);
          setHit(nextHit);
          previousQuery.current = text;
        }
      } catch (failure) {
        if (current === generation.current) {
          setResult(undefined);
          setError(failure instanceof Error ? failure.message : "搜索失败");
        }
      } finally {
        if (current === generation.current) setPending(false);
      }
    }, delay.current);
    delay.current = 200;
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [open, text, tagIds, composing, literal, attempt, projectId, revision]);
  useLayoutEffect(() => {
    if (!content.current || !open) return;
    const measure = () => {
      if (!dialog.current?.open || !content.current!.clientWidth) return;
      const nextNarrow = content.current!.clientWidth < 900;
      if (previousNarrow.current === false && nextNarrow && currentSelection.current.selected)
        setPreviewPage(true);
      previousNarrow.current = nextNarrow;
      setNarrow(nextNarrow);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [open]);
  const current = result?.results.find((card) => card.cardId === selected);
  const source = cards.find(
    (card) =>
      card.id === selected &&
      card.body.versionId === current?.bodyVersion &&
      card.versionId === current?.thoughtVersion,
  );
  const preview = useRef<{ key: string; card: Card; result: Result } | null>(
    null,
  );
  const previewKey = current ? current.cardId + ":" + result!.query.input : "";
  if (source && current)
    preview.current = { key: previewKey, card: source, result: current };
  const document = preview.current?.key === previewKey ? preview.current : null;
  const select = (id: string) => {
    navigation.current++;
    if (id !== selected) setHit(0);
    setSelected(id);
    setPreviewPage(true);
  };
  const canOpen =
    !!current && !pending && !composing && !opening && !error && !disabled;
  const openCurrent = async () => {
    if (!canOpen || !current) return;
    setOpening(true);
    const query = generation.current,
      request = ++navigation.current;
    const valid = () =>
      query === generation.current && request === navigation.current;
    try {
      const opened = await onOpen({ result: current, text, hit }, valid);
      if (!valid()) return;
      if (opened) close(false);
      else {
        setError("目标已更新或失效，请重新搜索");
        setAttempt((value) => value + 1);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "打开失败，请重试");
    } finally {
      setOpening(false);
    }
  };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k" ||
        event.isComposing ||
        event.keyCode === 229 ||
        composition.current ||
        disabled
      )
        return;
      if (
        (event.target as Element).closest(
          ".body-editor, [contenteditable=true], input, textarea",
        ) &&
        !dialog.current?.contains(event.target as Node)
      )
        return;
      event.preventDefault();
      setOpen(true);
      input.current?.focus();
    };
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, [disabled]);
  const focusResult = (index: number) => {
    const values = result?.results ?? [];
    const card = values[Math.max(0, Math.min(values.length - 1, index))];
    if (!card) return;
    navigation.current++;
    if (card.cardId !== selected) setHit(0);
    setSelected(card.cardId);
    dialog.current
      ?.querySelectorAll<HTMLElement>("[data-card-id]")
      [values.indexOf(card)]?.focus();
  };
  const repeat = () => {
    invalidate();
    retry.current = true;
    delay.current = 0;
    setLiteral(false);
    setAttempt((value) => value + 1);
  };
  return (
    <>
      <button
        ref={trigger}
        aria-label="搜索当前项目卡片"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        搜索
      </button>
      <dialog
        ref={dialog}
        className="project-search"
        aria-label="搜索当前项目卡片"
        onCancel={(event) => {
          event.preventDefault();
          if (picker) {
            setPicker(false);
            tagTrigger.current?.focus();
          } else if (explain) {
            setExplain(false);
            explanationTrigger.current?.focus();
          } else close();
        }}
        onClose={() => setOpen(false)}
        onPointerDown={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          outsideDown.current =
            event.target === event.currentTarget &&
            (event.clientX < box.left ||
              event.clientX > box.right ||
              event.clientY < box.top ||
              event.clientY > box.bottom);
          if (outsideDown.current) {
            event.preventDefault();
            event.stopPropagation();
          } else {
            if (
              !(event.target as Element).closest(".search-tag-picker") &&
              !tagTrigger.current?.contains(event.target as Node)
            )
              setPicker(false);
            if (
              !(event.target as Element).closest(".search-explanation") &&
              !explanationTrigger.current?.contains(event.target as Node)
            )
              setExplain(false);
          }
        }}
        onClick={(event) => {
          if (outsideDown.current && event.target === event.currentTarget) {
            event.preventDefault();
            event.stopPropagation();
            outsideDown.current = false;
            close();
          }
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            event.key === "Escape" &&
            (composition.current ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229)
          )
            event.preventDefault();
        }}
      >
        <header>
          <h2>搜索当前项目卡片</h2>
          <button aria-label="关闭搜索" onClick={() => close()}>
            关闭
          </button>
        </header>
        <label className="search-input">
          关键词
          <input
            ref={input}
            type="search"
            value={text}
            maxLength={10000}
            placeholder="搜索标题和完整正文"
            onChange={(event) => {
              invalidate();
              setText(event.target.value);
            }}
            onCompositionStart={() => {
              composition.current = true;
              invalidate();
              setComposing(true);
            }}
            onCompositionEnd={() => {
              composition.current = false;
              invalidate();
              setComposing(false);
            }}
            onKeyDown={(event) => {
              if (
                !composition.current &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229 &&
                event.key === "ArrowDown"
              ) {
                event.preventDefault();
                focusResult(
                  Math.max(
                    0,
                    result?.results.findIndex(
                      (card) => card.cardId === selected,
                    ) ?? 0,
                  ),
                );
              }
              if (
                event.key === "Enter" &&
                !composition.current &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault();
                if (canOpen) void openCurrent();
                else if (pending) {
                  invalidate();
                  delay.current = 0;
                  setAttempt((value) => value + 1);
                }
              }
            }}
          />
        </label>
        <div className="search-tags">
          <span>满足全部标签</span>
          <button
            ref={tagTrigger}
            aria-label="筛选标签"
            aria-expanded={picker}
            onClick={() => {
              setExplain(false);
              setPicker(!picker);
            }}
          >
            筛选标签
          </button>
          {tagIds.map((id) => {
            const tag = tags.find((t) => t.id === id);
            return (
              <button
                key={id}
                aria-label={`移除筛选标签 ${tag?.name ?? id}`}
                onClick={() => {
                  invalidate();
                  delay.current = 0;
                  setTagIds((ids) => ids.filter((v) => v !== id));
                }}
              >
                {tag && !tag.deleted ? (
                  <TagChip tag={tag} />
                ) : (
                  `${tag?.name ?? id}（已删除）`
                )}{" "}
                ×
              </button>
            );
          })}
          {!!tagIds.length && (
            <button
              onClick={() => {
                invalidate();
                delay.current = 0;
                setTagIds([]);
              }}
            >
              清除标签
            </button>
          )}
          {picker && (
            <section className="search-tag-picker" aria-label="标签筛选">
              <label>
                查找已有标签
                <input
                  autoFocus
                  type="search"
                  value={tagQuery}
                  onChange={(e) => setTagQuery(e.target.value)}
                />
              </label>
              {tags
                .filter(
                  (t) =>
                    !t.deleted &&
                    t.name.toLowerCase().includes(tagQuery.toLowerCase()),
                )
                .sort(compareTagNames)
                .map((tag) => (
                  <button
                    key={tag.id}
                    role="checkbox"
                    aria-checked={tagIds.includes(tag.id)}
                    onClick={() => {
                      invalidate();
                      delay.current = 0;
                      setTagIds((ids) =>
                        ids.includes(tag.id)
                          ? ids.filter((id) => id !== tag.id)
                          : [...ids, tag.id],
                      );
                    }}
                  >
                    <TagChip tag={tag} />
                  </button>
                ))}
              {!tags.some(
                (t) =>
                  !t.deleted &&
                  t.name.toLowerCase().includes(tagQuery.toLowerCase()),
              ) && <p>没有匹配的标签</p>}
              <button
                aria-label="完成标签筛选"
                onClick={() => {
                  setPicker(false);
                  tagTrigger.current?.focus();
                }}
              >
                完成
              </button>
            </section>
          )}
        </div>
        <div className="search-summary" aria-live="polite">
          {pending || composing ? (
            <span>正在搜索…</span>
          ) : result &&
            result.state !== "failed" &&
            result.state !== "invalid_tags" ? (
            <span>{result.results.length} 张卡片</span>
          ) : null}
          {text && (
            <button
              onClick={() => {
                invalidate();
                setText("");
              }}
            >
              清除关键词
            </button>
          )}
          {!pending && result?.query.units.length ? (
            <button
              ref={explanationTrigger}
              aria-expanded={explain}
              onClick={() => {
                setPicker(false);
                setExplain(!explain);
              }}
            >
              匹配说明
            </button>
          ) : null}
          {explain && !pending && !!result?.query.units.length && (
            <div className="search-explanation">
              <span>同时包含：</span>
              {result.query.units.map((unit, index) => (
                <span key={index}>
                  {unit.text}
                  {unit.phrase ? "（连续文字）" : ""}
                </span>
              ))}
              <p>不区分英文大小写和简繁体</p>
            </div>
          )}
        </div>
        {result?.query.unclosedQuote && <p>可补全右引号</p>}
        {(error || result?.state === "failed") && (
          <div className="search-failure" role="alert">
            <p>{error || result?.message}</p>
            <button onClick={repeat}>重试搜索</button>
            {result?.capabilities.normalization === "ready" &&
              result.capabilities.segmentation === "failed" && (
                <button
                  disabled={pending || composing}
                  onClick={() => {
                    if (pending || composing) return;
                    invalidate();
                    delay.current = 0;
                    setLiteral(true);
                  }}
                >
                  暂按完整片段搜索
                </button>
              )}
          </div>
        )}
        {result?.state === "degraded" && (
          <p className="search-limited">
            {result.message} <button onClick={repeat}>重试完整搜索</button>
          </p>
        )}
        {result?.state === "invalid_tags" && (
          <p role="alert">标签条件已失效，请移除或恢复对应标签后重试。</p>
        )}
        {!pending &&
          result &&
          ["ready", "degraded"].includes(result.state) &&
          !result.results.length && (
            <p className="search-empty">
              {result.query.units.length || tagIds.length
                ? "没有符合全部条件的卡片"
                : "当前项目还没有卡片"}
            </p>
          )}
        <div
          ref={content}
          className={`search-content${narrow ? " search-narrow" : ""}${previewPage ? " showing-preview" : ""}`}
        >
          <ul
            className="search-results"
            role="listbox"
            aria-label="搜索结果"
            aria-busy={pending}
            onKeyDown={(event) => {
              if (
                composition.current ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229 ||
                (event.target as Element).closest("button")
              )
                return;
              const index =
                result?.results.findIndex((card) => card.cardId === selected) ??
                0;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                focusResult(index + (event.key === "ArrowDown" ? 1 : -1));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                void openCurrent();
              }
            }}
          >
            {result?.results.map((card) => (
              <li
                key={card.cardId}
                data-card-id={card.cardId}
                tabIndex={0}
                role="option"
                aria-selected={card.cardId === selected}
                onClick={() => select(card.cardId)}
              >
                <h3>
                  <Highlight
                    text={card.title || "未命名卡片"}
                    ranges={card.titleHits}
                  />
                </h3>
                <div className="search-result-summary">
                  <Snippet result={card} />
                  {(() => {
                    const images =
                      cards
                        .find(
                          (source) =>
                            source.id === card.cardId &&
                            source.body.versionId === card.bodyVersion,
                        )
                        ?.body.blocks.filter(
                          (block) => block.type === "image",
                        ) ?? [];
                    return images.length ? (
                      <>
                        <SearchThumbnail
                          key={String(images[0]!.assetId)}
                          projectId={projectId}
                          image={images[0]!}
                        />
                        {!card.segments.some((s) => s.text) && (
                          <span>{images.length} 张图片</span>
                        )}
                      </>
                    ) : null;
                  })()}
                </div>
                {(() => {
                  const source = cards.find(
                    (source) => source.id === card.cardId,
                  );
                  const values = source ? cardTags(source, tags) : [];
                  return (
                    !!values.length && (
                      <div className="search-result-tags" aria-label="卡片标签">
                        {values.map((tag) => (
                          <TagChip key={tag.id} tag={tag} />
                        ))}
                      </div>
                    )
                  );
                })()}
              </li>
            ))}
          </ul>
          {narrow && !previewPage && current && (
            <button
              className="search-show-preview"
              onClick={() => setPreviewPage(true)}
            >
              查看预览
            </button>
          )}
          <section className="search-preview" aria-label="卡片只读预览">
            {narrow && (
              <button onClick={() => setPreviewPage(false)}>
                返回结果列表
              </button>
            )}
            {current ? (
              <>
                <h2>
                  <Highlight
                    text={current.title || "未命名卡片"}
                    ranges={current.titleHits}
                  />
                </h2>
                <HitNavigation
                  count={current.bodyHits.length}
                  hit={hit}
                  onHit={setHit}
                />
                {document ? (
                  <SearchDocument
                    key={previewKey}
                    projectId={projectId}
                    visible={open && (!narrow || previewPage)}
                    card={document.card}
                    result={document.result}
                    hit={hit}
                  />
                ) : (
                  <p role="alert">
                    正文版本正在更新。<button onClick={repeat}>重试预览</button>
                  </p>
                )}
              </>
            ) : (
              <p>选择一张卡片预览</p>
            )}
            <footer>
              <button disabled={!canOpen} onClick={() => void openCurrent()}>
                在画布中打开
              </button>
            </footer>
          </section>
        </div>
      </dialog>
    </>
  );
}
