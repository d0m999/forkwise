import { useLayoutEffect, useRef } from "react";

interface InlineTitleInterface {
  value: string;
  blocked: boolean;
  onChange: (value: string) => void;
  onFinish: () => void;
  onComposition: (value: boolean) => void;
}

// Each mounted editor is one title round. Keep its native defaultValue fixed:
// changing textarea's default on every keystroke adds invisible native undo
// steps. The draft coordinator still owns input, saving and remote readback.
export function InlineTitle({
  value,
  blocked,
  onChange,
  onFinish,
  onComposition,
}: InlineTitleInterface) {
  const element = useRef<HTMLTextAreaElement>(null);
  const initial = useRef(value);
  useLayoutEffect(() => {
    if (element.current) {
      if (element.current.value !== value) element.current.value = value;
      element.current.style.height = "auto";
      element.current.style.height = `${element.current.scrollHeight}px`;
    }
  }, [value]);
  return (
    <textarea
      ref={element}
      className="card-title nodrag nowheel"
      aria-label="卡片标题"
      autoFocus
      readOnly={blocked}
      defaultValue={initial.current}
      onChange={(event) => onChange(event.target.value)}
      onCompositionStart={() => onComposition(true)}
      onCompositionEnd={() => onComposition(false)}
      onBlur={onFinish}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (
          (event.key === "Enter" && !event.shiftKey) ||
          event.key === "Escape"
        ) {
          event.preventDefault();
          onFinish();
        }
      }}
    />
  );
}
