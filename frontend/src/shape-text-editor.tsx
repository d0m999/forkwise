import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useNearbyCanvasControls } from "./nearby-canvas-controls";
import type { ShapeTextConflict, ShapeTextSession } from "./shape-text-save";
import { LayerMenu, type LayerMenuProps } from "./layer-menu";

export function ShapeTextAction({ anchor, edit, appearance, remove, removeFromGroup, layer, annotation }: {
  anchor: RefObject<HTMLDivElement | null>; edit: () => void; appearance: (trigger: HTMLButtonElement) => void; remove: () => void;
  annotation?: ReactNode; removeFromGroup?: (() => void) | undefined; layer?: LayerMenuProps | undefined;
}) {
  const element = useRef<HTMLDivElement>(null);
  const { positions, placePopup } = useNearbyCanvasControls(anchor, element);
  return createPortal(<div ref={element} className="shape-text-actions shape-text-actions--floating" role="toolbar" aria-label="形状操作"
    style={{ ...positions?.toolbar, maxWidth: positions?.maxWidth, visibility: positions ? undefined : "hidden" }}>
    <button onClick={event => { event.stopPropagation(); edit(); }}>编辑形状文字</button>
    <button aria-haspopup="dialog" onClick={event => appearance(event.currentTarget)}>形状外观</button>
    <button onClick={remove}>删除形状</button>
    {annotation}
    {layer && <LayerMenu {...layer} placePopup={placePopup} />}
    {removeFromGroup && <button onClick={event => { event.stopPropagation(); removeFromGroup(); }}>移出组合</button>}
  </div>, document.body);
}

export function ShapeTextEditor({ session, locked, error, change, compose, finish, appearance, conflict, recovering, recover }: {
  session: ShapeTextSession; locked: boolean; error: string; change: (input: string) => void;
  compose: (active: boolean) => void; finish: () => void;
  appearance: (trigger: HTMLButtonElement) => void;
  conflict: ShapeTextConflict | null; recovering: boolean; recover: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null), composing = useRef(false);
  const initial = useRef(session.input);
  useLayoutEffect(() => { input.current?.focus(); }, []);
  return <div className="shape-text-session nodrag nopan nowheel" style={{
    position: "absolute", left: session.value.item.pose.x, top: session.value.item.pose.y,
    width: session.value.item.pose.width, height: session.value.item.pose.height, zIndex: 1000, pointerEvents: "all",
  }} onClick={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}>
    <textarea ref={input} className="shape-text-input nodrag nowheel" aria-label="形状文字"
      defaultValue={initial.current} readOnly={locked}
      style={{ width: "100%", height: "100%", boxSizing: "border-box", resize: "none", font: "inherit", padding: 8 }}
      onChange={event => change(event.target.value)}
      onCompositionStart={() => { composing.current = true; compose(true); }}
      onCompositionEnd={event => { change(event.currentTarget.value); composing.current = false; compose(false); }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape" || event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault(); event.stopPropagation(); finish();
        }
      }} />
    <div className="shape-text-actions shape-text-actions--editor">
      {error && <p role="alert">{error}；输入仍保留在原形状</p>}
      {conflict ? <section aria-label="形状文字保存冲突" onKeyDown={event => event.stopPropagation()}>
        <p>原形状保留已保存的版本；将我的完整内容和位置恢复为独立形状。</p>
        <label>已保存的形状文字<textarea className="shape-text-input" aria-label="已保存的形状文字" readOnly
          value={conflict.remote?.content.shortText ?? "原形状已删除"} /></label>
        <label>我的形状文字<textarea className="shape-text-input" aria-label="我的形状文字" readOnly value={session.input} /></label>
        <button disabled={locked} onClick={recover}>{recovering ? "重试恢复我的形状" : "保留对方并恢复我的形状"}</button>
      </section> : <>
        <button disabled={locked && !error} onClick={finish}>{error ? "重试保存形状文字" : "保存形状文字"}</button>
        <button disabled={locked} aria-haspopup="dialog" onClick={event => appearance(event.currentTarget)}>形状外观</button>
      </>}
    </div>
  </div>;
}
