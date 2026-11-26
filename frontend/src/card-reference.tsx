import { useRef, useState, type FormEvent } from "react";
import "./card-reference.css";

export function CardReference({
  disabled,
  onOpen,
}: {
  disabled: boolean;
  onOpen: (reference: string, valid: () => boolean) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const [reference, setReference] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  function close() {
    request.current?.abort();
    request.current = null;
    dialog.current?.close();
    setPending(false);
    setReference("");
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = reference.trim();
    if (!value || request.current || disabled) return;
    const controller = new AbortController();
    request.current = controller;
    const valid = () => !controller.signal.aborted && !!dialog.current?.open;
    setPending(true);
    setError("");
    try {
      await onOpen(value, valid);
      if (valid()) close();
    } catch (failure) {
      if (valid()) setError(failure instanceof Error ? failure.message : "无法打开卡片引用，请重试");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
      }
    }
  }

  return (
    <>
      <button type="button" disabled={disabled} aria-haspopup="dialog" onClick={() => {
        dialog.current?.showModal();
        input.current?.focus();
      }}>打开卡片引用</button>
      <dialog ref={dialog} className="card-reference-dialog" aria-labelledby="card-reference-title"
        onCancel={event => { event.preventDefault(); close(); }}
        onKeyDown={event => event.stopPropagation()}>
        <form onSubmit={event => void submit(event)}>
          <h2 id="card-reference-title">打开卡片引用</h2>
          <label htmlFor="card-reference-input">卡片引用</label>
          <input id="card-reference-input" ref={input} value={reference}
            autoComplete="off" spellCheck={false} readOnly={pending}
            onChange={event => { setReference(event.target.value); setError(""); }} />
          {error && <p role="alert">{error}</p>}
          <footer>
            <button type="button" onClick={close}>取消</button>
            <button type="submit" disabled={disabled || pending || !reference.trim()}>
              {pending ? "正在打开…" : "打开"}
            </button>
          </footer>
        </form>
      </dialog>
    </>
  );
}
