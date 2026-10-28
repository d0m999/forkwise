import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { CanvasConnector } from '../../backend/src/mapping/connector-contracts';
import type { ConnectorLabelSession, LabelConflict } from './connector-label-edit';
import { connectorPathPosition } from './connector-geometry';

export type LabelEditor = { session: ConnectorLabelSession | null; error: string; working: boolean;
  begin: (origin: HTMLElement | SVGElement) => void; change: (text: string) => void; boundary: () => void; compose: (active: boolean) => void; finish: () => void;
  history: (direction: 'undo' | 'redo') => Promise<void>; locked: boolean;
  blocked: boolean; move: (original: CanvasConnector, position: number) => void;
  conflict: LabelConflict | null; resolve: (choice: 'mine' | 'remote') => Promise<boolean>; stash: () => boolean };
type TextEditor = Pick<LabelEditor, 'session' | 'working' | 'error' | 'change' | 'boundary' | 'compose' | 'finish' | 'conflict' | 'resolve' | 'stash' | 'history' | 'locked'>;
export function ConnectorLabel({ value, path, origin, geometry, editor, choose }: {
  value: CanvasConnector; path: RefObject<SVGPathElement | null>; origin: { x: number; y: number }; geometry: string; editor: LabelEditor; choose: (extend: boolean) => void;
}) {
  const [point, setPoint] = useState({ x: 0, y: 0 });
  const [preview, setPreview] = useState<number | null>(null);
  const drag = useRef<{ original: CanvasConnector; pointer: number; element: HTMLButtonElement; x: number; y: number; position: number; moved: boolean } | null>(null);
  const session = editor.session?.value.id === value.id ? editor.session : null, label = session?.label ?? value.label;
  function cancel() {
    const active = drag.current; drag.current = null; setPreview(null);
    if (active?.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
  }
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') cancel(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !drag.current || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
    };
    window.addEventListener('blur', cancel); window.addEventListener('pagehide', cancel); window.addEventListener('keydown', escape, true);
    document.addEventListener('visibilitychange', hidden);
    return () => { cancel(); window.removeEventListener('blur', cancel); window.removeEventListener('pagehide', cancel); window.removeEventListener('keydown', escape, true); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  useLayoutEffect(() => { setPreview(null); }, [value.versionId]);
  useLayoutEffect(() => {
    const element = path.current;
    if (element) setPoint(element.getPointAtLength(element.getTotalLength() * (preview ?? label?.position ?? 0.5)));
  }, [geometry, label?.position, preview, path]);
  if (!label) return null;
  const style = { left: origin.x + point.x, top: origin.y + point.y, fontSize: label.fontSize, color: label.color, fontWeight: label.bold ? 700 : 400 };
  if (session) return <div className="connector-label connector-label-session nodrag nopan nowheel" style={style}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <LabelContents session={session} editor={editor} />
  </div>;
  return <button type="button" className="connector-label nodrag nopan" data-connector-id={value.id} style={style} aria-label="连线文字"
    onPointerDown={event => {
      event.stopPropagation();
      if (event.button !== 0 || editor.blocked || !value.label) return;
      event.preventDefault(); choose(event.shiftKey);
      drag.current = { original: structuredClone(value), pointer: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY, position: value.label.position, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const active = drag.current;
      if (!active || active.pointer !== event.pointerId || !path.current) return;
      event.preventDefault(); event.stopPropagation();
      if (!active.moved && Math.hypot(event.clientX - active.x, event.clientY - active.y) < 3) return;
      const position = connectorPathPosition(path.current, { x: event.clientX, y: event.clientY });
      if (position === null) return;
      active.moved = true; active.position = position; setPreview(position);
    }}
    onPointerUp={event => {
      const active = drag.current;
      if (!active || active.pointer !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation(); drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (active.moved && Math.abs(active.position - active.original.label!.position) > 0.0001) editor.move(active.original, active.position);
      else setPreview(null);
    }}
    onPointerCancel={cancel} onLostPointerCapture={() => { if (drag.current) cancel(); }}
    onClick={event => { event.stopPropagation(); if (event.detail === 0) choose(event.shiftKey); }}
    onDoubleClick={event => { event.stopPropagation(); editor.begin(event.currentTarget); }}>{label.text}</button>;
}
export function DetachedConnectorLabelEditor({ editor }: { editor: TextEditor }) {
  if (!editor.session) return null;
  return <section className="recovery-panel connector-label-session" aria-label="已移除连线的文字">
    <p>连线已移除，未确认的文字仍保留。</p><LabelContents session={editor.session} editor={editor} />
  </section>;
}
function LabelContents({ session, editor }: { session: ConnectorLabelSession; editor: TextEditor }) {
  const remote = editor.conflict?.remote?.label;
  const differences = remote ? ([
    ['字号', `${session.label.fontSize} px`, `${remote.fontSize} px`],
    ['颜色', session.label.color, remote.color],
    ['粗体', session.label.bold ? '加粗' : '常规', remote.bold ? '加粗' : '常规'],
    ['路径位置', `${session.label.position * 100}%`, `${remote.position * 100}%`],
  ] as const).filter(([, mine, saved]) => mine !== saved) : [];
  return <><LabelInput value={session.label.text} editor={editor} />
    {editor.error && <p role="alert">{editor.error}；完整输入仍保留</p>}
    {editor.conflict ? <section aria-label="连线文字保存冲突">
      <label>已保存的连线文字<textarea className="connector-label-input" aria-label="已保存的连线文字" readOnly
        style={remote ? { fontSize: remote.fontSize, color: remote.color, fontWeight: remote.bold ? 700 : 400 } : undefined}
        value={remote?.text ?? (editor.conflict.remote ? '无标签' : '连线已删除')} /></label>
      {differences.length > 0 && <section className="connector-label-differences" aria-label="标签样式差异">
        {differences.map(([name, mine, saved]) => <p key={name}>{name}：我的文字 {mine}；已保存 {saved}</p>)}
      </section>}
      <button type="button" disabled={editor.working || editor.locked || !editor.conflict.remote} onClick={() => void editor.resolve('mine')}>确认保留我的文字</button>
      <button type="button" disabled={editor.working || editor.locked} onClick={() => void editor.resolve('remote')}>确认保留已保存的文字</button>
      <button type="button" disabled={editor.working || editor.locked} onClick={() => editor.stash()}>保留草稿并结束</button>
    </section> : <button type="button" disabled={editor.working || editor.locked} onClick={editor.finish}>{editor.error ? '重试保存文字' : '保存文字'}</button>}
  </>;
}
function LabelInput({ value, editor }: { value: string; editor: TextEditor }) {
  const input = useRef<HTMLTextAreaElement>(null), composing = useRef(false);
  const inputType = useRef<string | null>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const historySelection = useRef<{ start: number; end: number } | null>(null), locked = useRef(editor.locked);
  locked.current = editor.locked;
  function restoreHistorySelection() {
    const element = input.current, saved = historySelection.current;
    if (!element?.isConnected || !saved) return;
    selection.current = { start: Math.min(saved.start, element.value.length), end: Math.min(saved.end, element.value.length) };
    element.focus({ preventScroll: true }); element.setSelectionRange(selection.current.start, selection.current.end);
    if (!locked.current) historySelection.current = null;
  }
  useLayoutEffect(() => { input.current?.focus(); }, []);
  useLayoutEffect(() => { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = input.current.scrollHeight + 'px'; } }, [value]);
  useLayoutEffect(() => { if (!editor.locked) restoreHistorySelection(); }, [editor.locked, value]);
  return <textarea ref={input} aria-label="连线文字" className="connector-label-input nodrag nopan nowheel" value={value} readOnly={editor.locked || editor.working && !!editor.conflict}
    onChange={event => {
      const nextType = (event.nativeEvent as InputEvent).inputType || 'insertText';
      if (!composing.current) {
        if (inputType.current && (nextType !== inputType.current || nextType === 'insertFromPaste')) editor.boundary();
        inputType.current = nextType;
      }
      selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }; editor.change(event.target.value);
    }}
    onSelect={event => {
      const next = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }, previous = selection.current;
      if (!composing.current && previous && (next.start !== previous.start || next.end !== previous.end)) editor.boundary();
      selection.current = next;
    }}
    onBlur={() => { if (!composing.current && !locked.current) editor.boundary(); }}
    onCompositionStart={() => { composing.current = true; editor.compose(true); }}
    onCompositionEnd={event => { editor.change(event.currentTarget.value); composing.current = false; inputType.current = 'insertCompositionText'; editor.compose(false); }}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopPropagation();
        if (editor.locked) return;
        historySelection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
        void editor.history(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo').then(() => requestAnimationFrame(restoreHistorySelection));
        return;
      }
      if (event.key === 'Escape' || event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); if (!editor.locked) editor.finish(); }
    }} />;
}
