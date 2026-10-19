import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "./api";
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

export function ProjectSearch({
  projectId,
  revision,
  disabled,
}: {
  projectId: string;
  revision: number;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false),
    [text, setText] = useState("");
  const [composing, setComposing] = useState(false),
    [literal, setLiteral] = useState(false);
  const [attempt, setAttempt] = useState(0),
    [explain, setExplain] = useState(false);
  const [result, setResult] = useState<SearchResult>(),
    [error, setError] = useState("");
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
  };
  const close = () => {
    if (!composition.current) {
      generation.current++;
      dialog.current?.close();
      setOpen(false);
      trigger.current?.focus();
    }
  };
  useEffect(() => {
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
          literal,
          retry: retryLibrary,
        });
        if (current === generation.current) setResult(value);
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
  }, [open, text, composing, literal, attempt, projectId, revision]);
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
          close();
        }}
        onClose={() => setOpen(false)}
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
          <button aria-label="关闭搜索" onClick={close}>
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
                event.key === "Enter" &&
                !composition.current &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault();
                invalidate();
                delay.current = 0;
                setAttempt((value) => value + 1);
              }
            }}
          />
        </label>
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
          {result?.query.units.length ? (
            <button
              aria-expanded={explain}
              onClick={() => setExplain(!explain)}
            >
              匹配说明
            </button>
          ) : null}
        </div>
        {explain && result && (
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
              {result.query.units.length
                ? "没有符合全部条件的卡片"
                : "当前项目还没有卡片"}
            </p>
          )}
        <ul
          className="search-results"
          aria-label="搜索结果"
          aria-busy={pending}
        >
          {result?.results.map((card) => (
            <li key={card.cardId} data-card-id={card.cardId}>
              <h3>
                <Highlight
                  text={card.title || "未命名卡片"}
                  ranges={card.titleHits}
                />
              </h3>
              <Snippet result={card} />
            </li>
          ))}
        </ul>
      </dialog>
    </>
  );
}
