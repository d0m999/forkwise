import { useEffect, useRef, useState } from "react";
import { api, type Card } from "./api";
import { HitNavigation } from "./search-preview";
import { searchHitIdentity, type SearchReading } from "./search-reading";

export function BodyFind({
  projectId,
  card,
  seed,
  updating,
  onReading,
}: {
  projectId: string;
  card: Card;
  seed: SearchReading | null;
  updating: boolean;
  onReading: (reading: SearchReading | null) => void;
}) {
  const [open, setOpen] = useState(!!seed),
    [text, setText] = useState(seed?.text ?? "");
  const [reading, setReading] = useState<SearchReading | null>(seed);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const [composing, setComposing] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    generation = useRef(0),
    composition = useRef(false);
  const lastQuery = useRef(seed?.text ?? ""),
    lastVersion = useRef(seed?.result.bodyVersion);
  const show = (value: SearchReading | null) => {
    setReading(value);
    onReading(value);
  };
  useEffect(() => {
    if (seed) {
      setOpen(true);
      setText(seed.text);
      show(seed);
      lastQuery.current = seed.text;
      lastVersion.current = seed.result.bodyVersion;
    }
  }, [seed]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "f" ||
        event.isComposing ||
        event.keyCode === 229 ||
        !(event.target as Element).closest(".body-editor")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, []);
  useEffect(() => {
    if (!open || composing) return;
    if (updating) {
      setPending(true);
      return;
    }
    if (
      reading &&
      lastQuery.current === text &&
      lastVersion.current === card.body.versionId &&
      !attempt
    ) {
      setPending(false);
      setError("");
      return;
    }
    const current = ++generation.current;
    setPending(true);
    setError("");
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.search(projectId, { text });
        if (current !== generation.current) return;
        if (result.state === "failed")
          throw new Error(result.message ?? "查找失败");
        const match = result.results.find(
          (result) =>
            result.cardId === card.id &&
            result.bodyVersion === card.body.versionId,
        );
        const sameQuery = lastQuery.current === text;
        const identity = reading && searchHitIdentity(reading.result, reading.hit);
        const retainedHit = sameQuery && identity && match
          ? match.bodyHits.findIndex((_, index) => searchHitIdentity(match, index) === identity)
          : -1;
        const next = match
          ? {
              result: match,
              text,
              preserveViewport: retainedHit >= 0,
              hit:
                sameQuery
                  ? retainedHit >= 0 ? retainedHit : Math.min(
                      reading?.hit ?? 0,
                      Math.max(0, match.bodyHits.length - 1),
                    )
                  : 0,
            }
          : null;
        show(next);
        lastQuery.current = text;
        lastVersion.current = card.body.versionId;
      } catch (failure) {
        if (current === generation.current) {
          show(null);
          setError(failure instanceof Error ? failure.message : "查找失败");
        }
      } finally {
        if (current === generation.current) setPending(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [
    open,
    text,
    composing,
    card.body.versionId,
    card.versionId,
    projectId,
    attempt,
    updating,
  ]);
  const close = () => {
    if (composition.current) return;
    generation.current++;
    setOpen(false);
    show(null);
  };
  if (!open) return null;
  return (
    <section
      className="body-find"
      aria-label="当前正文查找"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (
          event.key === "Escape" &&
          !composition.current &&
          !event.nativeEvent.isComposing &&
          event.keyCode !== 229
        ) {
          event.preventDefault();
          close();
        }
      }}
    >
      <label>
        查找当前正文
        <input
          ref={input}
          type="search"
          value={text}
          onChange={(event) => {
            generation.current++;
            setPending(true);
            setText(event.target.value);
          }}
          onCompositionStart={() => {
            composition.current = true;
            generation.current++;
            setComposing(true);
          }}
          onCompositionEnd={() => {
            composition.current = false;
            setComposing(false);
          }}
        />
      </label>
      {pending || updating ? (
        <span aria-live="polite">正在查找…</span>
      ) : error ? (
        <p role="alert">
          {error}{" "}
          <button onClick={() => setAttempt((value) => value + 1)}>
            重试查找
          </button>
        </p>
      ) : reading?.result.bodyHits.length ? (
        <HitNavigation
          count={reading.result.bodyHits.length}
          hit={reading.hit}
          onHit={(hit) => show({ ...reading, hit, preserveViewport: false })}
        />
      ) : (
        <span>{text ? "正文没有匹配" : "输入关键词查找正文"}</span>
      )}
      <button aria-label="结束正文查找" onClick={close}>
        关闭查找
      </button>
    </section>
  );
}
