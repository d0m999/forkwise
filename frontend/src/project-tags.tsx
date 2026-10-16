import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { Card, Command, Tag } from '../../backend/src/mapping/contracts';
import type { ProjectState } from './api';

export const TAG_PALETTE = [
  ['默认', '#f1f0ec'], ['灰色', '#e3e2df'], ['棕色', '#eee0da'],
  ['橙色', '#f8dfc4'], ['黄色', '#f4e9b9'], ['绿色', '#dce8dd'],
  ['蓝色', '#d9e7f1'], ['紫色', '#e8dff0'], ['粉色', '#f1dfe8'], ['红色', '#f3dcd8'],
] as const;
export const tagColorName = (color: string) => TAG_PALETTE.find(([, value]) => value === color.toLowerCase())?.[0] ?? '原有颜色';
const tagStyle = (tag: Tag) => ({
  '--tag-color': tag.color,
  '--tag-pigment': tagColorName(tag.color) === '原有颜色' ? '15%' : '55%',
} as CSSProperties);
const isCompositionKey = (event: { keyCode: number; nativeEvent: { isComposing: boolean } }) => event.nativeEvent.isComposing || event.keyCode === 229;
export function cardTags(card: Card, tags: Tag[]) {
  return (card.cardTags?.tagIds ?? []).flatMap(id => {
    const tag = tags.find(t => t.id === id && !t.deleted);
    return tag ? [tag] : [];
  });
}
export function TagChip({ tag }: { tag: Tag }) {
  return <span className="project-tag" style={tagStyle(tag)} title={tag.name}>{tag.name}</span>;
}
export function CardTagSummary({ card, tags, onOpen }: { card: Card; tags: Tag[]; onOpen: () => void }) {
  const values = cardTags(card, tags);
  const row = useRef<HTMLDivElement>(null), measuring = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(values.length);
  useLayoutEffect(() => {
    if (!row.current || !measuring.current) return;
    const measure = () => {
      const host = row.current!, samples = measuring.current!;
      const style = getComputedStyle(host), available = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const widths = [...samples.querySelectorAll<HTMLElement>('.tag-measure-chip')].map(e => e.offsetWidth);
      const more = samples.querySelector<HTMLElement>('.tag-overflow-measure')!.offsetWidth, gap = parseFloat(style.columnGap) || 0;
      let count = widths.length;
      while (count > 0 && widths.slice(0, count).reduce((s, n) => s + n, 0) + Math.max(0, count - 1) * gap + (count < widths.length ? more + gap : 0) > available) count--;
      setLimit(previous => previous === count ? previous : count);
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(row.current);
    let active = true; document.fonts.ready.then(() => { if (active) measure(); });
    return () => { active = false; observer.disconnect(); };
  }, [card, tags]);
  return values.length ? <>
    <div ref={row} className="card-visible-tags">
      {values.slice(0, limit).map(tag => <TagChip key={tag.id} tag={tag} />)}
      {limit < values.length && <button type="button" className="tag-overflow nodrag nopan" aria-label={`查看另外 ${values.length - limit} 个标签`} onClick={e => { e.stopPropagation(); onOpen(); }}>+{values.length - limit}</button>}
    </div>
    <div ref={measuring} className="tag-measuring" aria-hidden="true">{values.map(tag => <span className="tag-measure-chip" key={tag.id}>{tag.name}</span>)}<span className="tag-overflow-measure">+{values.length}</span></div>
  </> : null;
}
type Props = {
  state: ProjectState; card: Card; blocked: boolean;
  execute: (command: Command, onDone?: () => void) => Promise<boolean | undefined>;
  refresh: (projectId: string) => Promise<ProjectState>;
  undo: (actionId: string) => void;
};
function TagName({ tag, blocked, save }: { tag: Tag; blocked: boolean; save: (name: string) => void }) {
  const [value, setValue] = useState(tag.name);
  useLayoutEffect(() => setValue(tag.name), [tag.name]);
  return <form onSubmit={e => { e.preventDefault(); if (!blocked && value !== tag.name) save(value); }}>
    <input aria-label={`重命名 ${tag.name}`} value={value} maxLength={240} required disabled={blocked} onChange={e => setValue(e.target.value)} />
    <button disabled={blocked || value === tag.name} aria-label={`保存 ${tag.name} 名称`}>保存</button>
  </form>;
}
function Palette({ tag, blocked, close, save }: { tag: Tag; blocked: boolean; close: () => void; save: (color: typeof TAG_PALETTE[number][1]) => void }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const buttons = [...host.current!.querySelectorAll<HTMLButtonElement>('[data-tag-swatch]')];
    (buttons.find(b => b.getAttribute('aria-pressed') === 'true') ?? buttons[0])?.focus();
  }, [tag.id]);
  return <div ref={host} className="tag-palette" role="group" aria-label={`${tag.name}标签颜色`} onKeyDown={e => {
    e.stopPropagation(); if (isCompositionKey(e)) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    const offset = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 5, ArrowUp: -5 }[e.key];
    if (offset !== undefined || e.key === 'Home' || e.key === 'End') {
      e.preventDefault(); const buttons = [...host.current!.querySelectorAll<HTMLButtonElement>('[data-tag-swatch]')];
      const i = buttons.indexOf(e.target as HTMLButtonElement);
      buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (offset ?? 0) + buttons.length) % buttons.length]?.focus();
    }
  }}>
    <div className="tag-palette-heading"><strong>标签颜色</strong><button type="button" onClick={close}>关闭颜色</button></div>
    <div className="tag-swatches">{TAG_PALETTE.map(([name, color]) => <button type="button" key={color} data-tag-swatch={color} aria-label={name} aria-pressed={tag.color.toLowerCase() === color} aria-disabled={blocked} style={{ '--swatch': color } as CSSProperties} onClick={() => { if (!blocked && tag.color.toLowerCase() !== color) save(color); }} />)}</div>
    <p aria-live="polite">当前：{tagColorName(tag.color)} · 点击即保存</p>
    {tagColorName(tag.color) === '原有颜色' && <p className="tag-legacy"><span style={tagStyle(tag)} />原有颜色已保留</p>}
  </div>;
}
export function ProjectTags({ state, card, blocked, execute, refresh, undo }: Props) {
  const [open, setOpen] = useState(false), [colorId, setColorId] = useState<string | null>(null);
  const [name, setName] = useState(''), [query, setQuery] = useState('');
  const [pendingIds, setPendingIds] = useState<string[] | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const drag = useRef<{ pointer: number; id: string; over: string; ids: string[]; version: string | null } | null>(null);
  const [confirmation, setConfirmation] = useState<{ tag: Tag; expected: { tag: string; cardTags: Record<string, string> }; count: number } | null>(null);
  const [checking, setChecking] = useState(false), [notice, setNotice] = useState('');
  const [deletedAction, setDeletedAction] = useState<{ id: string; tagId: string; name: string } | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const manage = useRef<HTMLButtonElement>(null), triggers = useRef(new Map<string, HTMLButtonElement>());
  const tags = (state.tags ?? []).filter(t => !t.deleted);
  const selected = cardTags(card, tags);
  const sorted = tags.filter(t => t.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const run = (value: Omit<Command, 'projectId' | 'commandId'>, onDone?: () => void) => execute({ ...value, commandId: crypto.randomUUID(), projectId: state.project.id } as Command, onDone);
  function closePalette() { const id = colorId; setColorId(null); if (id) triggers.current.get(id)?.focus(); }
  function range(snapshot: ProjectState, id: string) {
    const tag = snapshot.tags?.find(t => t.id === id && !t.deleted);
    if (!tag) return null;
    const cards = snapshot.cards.filter(c => c.cardTags?.tagIds.includes(id));
    return { tag, count: cards.length, expected: { tag: tag.versionId, cardTags: Object.fromEntries(cards.sort((a, b) => a.id.localeCompare(b.id)).map(c => [c.id, c.cardTags!.versionId])) } };
  }
  async function prepareDelete(id: string) {
    setChecking(true); setNotice(''); setColorId(null);
    try { const fresh = await refresh(state.project.id); const current = range(fresh, id); if (current) setConfirmation(current); else setNotice('标签已不存在，请重新读取'); }
    catch { setNotice('标签范围读取失败，请重试'); }
    finally { setChecking(false); }
  }
  async function confirmDelete() {
    const current = confirmation; if (!current || blocked) return;
    setConfirmation(null); setNotice('');
    const command: Command = { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'tag.delete', payload: { id: current.tag.id }, expected: current.expected };
    const ok = await execute(command, () => { setDeletedAction({ id: command.commandId, tagId: current.tag.id, name: current.tag.name }); setColorId(null); });
    if (!ok) {
      try {
        const latest = range(await refresh(state.project.id), current.tag.id);
        setNotice(latest && JSON.stringify(latest.expected) !== JSON.stringify(current.expected) ? '删除依据已变化，请重新读取并重新确认' : '删除结果尚未确认，请重试原保存请求');
      } catch { setNotice('删除尚未确认，请检查保存提示'); }
    }
  }
  return <section className="project-tags" onKeyDown={e => {
    e.stopPropagation(); if (isCompositionKey(e)) return;
    if (e.key === 'Escape') { e.preventDefault(); if (colorId) closePalette(); else { setOpen(false); manage.current?.focus(); } }
  }}>
    <div className="board-tags" aria-label="当前卡片完整标签">{selected.map(tag => <div className="board-tag-item" data-board-tag={tag.id} data-drag-over={over === tag.id} key={tag.id}>
      <button type="button" className="tag-drag" aria-label={`拖动标签：${tag.name}`} disabled={blocked} onPointerDown={e => {
        if (e.button !== 0 || blocked) return; e.preventDefault(); e.stopPropagation();
        e.currentTarget.focus();
        drag.current = { pointer: e.pointerId, id: tag.id, over: tag.id, ids: [...(card.cardTags?.tagIds ?? [])], version: card.cardTags?.versionId ?? null };
        e.currentTarget.setPointerCapture(e.pointerId);
      }} onPointerMove={e => {
        const current = drag.current; if (!current || current.pointer !== e.pointerId) return;
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-board-tag]');
        if (target && e.currentTarget.closest('.board-tags')?.contains(target)) { current.over = target.dataset.boardTag!; setOver(current.over); }
      }} onPointerUp={e => {
        const current = drag.current; if (!current || current.pointer !== e.pointerId) return;
        drag.current = null; setOver(null); e.currentTarget.releasePointerCapture(e.pointerId);
        if (current.id === current.over) return;
        const tagIds = [...current.ids], from = tagIds.indexOf(current.id), to = tagIds.indexOf(current.over);
        tagIds.splice(from, 1); tagIds.splice(to, 0, current.id);
        void run({ type: 'card.tags', expected: current.version, payload: { id: card.id, tagIds } });
      }} onPointerCancel={() => { drag.current = null; setOver(null); }} onLostPointerCapture={() => { drag.current = null; setOver(null); }} onKeyDown={e => {
        if (isCompositionKey(e)) return;
        if (e.key === 'Escape' && drag.current) {
          const pointer = drag.current.pointer; drag.current = null; setOver(null); e.preventDefault(); e.stopPropagation();
          if (e.currentTarget.hasPointerCapture(pointer)) e.currentTarget.releasePointerCapture(pointer);
          return;
        }
        const offset = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0;
        if (!offset) return; e.preventDefault();
        const ids = [...(card.cardTags?.tagIds ?? [])], i = ids.indexOf(tag.id), to = i + offset;
        if (to < 0 || to >= ids.length) return; [ids[i], ids[to]] = [ids[to]!, ids[i]!];
        void run({ type: 'card.tags', expected: card.cardTags?.versionId ?? null, payload: { id: card.id, tagIds: ids } });
      }}>拖动</button><TagChip tag={tag} />
    </div>)}</div>
    <button ref={manage} type="button" disabled={blocked} aria-expanded={open} onClick={() => { setOpen(!open); setColorId(null); }}>管理标签</button>
    {open && <section className="tag-manager" aria-label="项目标签">
      <div className="tag-palette-heading"><strong>项目标签</strong><button type="button" onClick={() => { setOpen(false); setColorId(null); manage.current?.focus(); }}>完成标签管理</button></div>
      <p>项目内共用名称和颜色。创建时添加到当前卡片，也可勾选已有标签。</p>
      <label>查找项目标签<input aria-label="查找项目标签" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div className="tag-options">{sorted.map(tag => <div className="tag-option" key={tag.id}>
        <div className="tag-option-row">
          <input type="checkbox" aria-label={`添加 ${tag.name} 到卡片`} disabled={blocked || !!pendingIds} checked={(pendingIds ?? selected.map(t => t.id)).includes(tag.id)} onChange={e => {
            const ids = card.cardTags?.tagIds ?? [];
            const tagIds = e.target.checked ? [...ids, tag.id] : ids.filter(id => id !== tag.id);
            setPendingIds(tagIds);
            void run({ type: 'card.tags', expected: card.cardTags?.versionId ?? null, payload: { id: card.id, tagIds } }).finally(() => setPendingIds(null));
          }} />
          <button ref={node => { if (node) triggers.current.set(tag.id, node); else triggers.current.delete(tag.id); }} type="button" className="tag-color-trigger" style={tagStyle(tag)} aria-label={`${tag.name}颜色：${tagColorName(tag.color)}`} aria-expanded={colorId === tag.id} aria-disabled={blocked && colorId !== tag.id} onClick={() => { if (colorId === tag.id) closePalette(); else if (!blocked) setColorId(tag.id); }}><span aria-hidden="true" /></button>
          <TagName tag={tag} blocked={blocked} save={name => { void run({ type: 'tag.update', expected: tag.versionId, payload: { id: tag.id, name } }); }} />
          <button type="button" aria-label={`删除项目标签：${tag.name}`} disabled={blocked || checking} onClick={e => { deleteTrigger.current = e.currentTarget; void prepareDelete(tag.id); }}>删除</button>
        </div>
        {colorId === tag.id && <Palette tag={tag} blocked={blocked} close={closePalette} save={color => { void run({ type: 'tag.update', expected: tag.versionId, payload: { id: tag.id, color } }); }} />}
      </div>)}</div>
      {!sorted.length && <p>没有匹配的项目标签</p>}
      <form className="tag-create" onSubmit={e => { e.preventDefault(); if (!name || blocked) return; void run({ type: 'tag.create', expected: { cardTags: card.cardTags?.versionId ?? null }, payload: { id: crypto.randomUUID(), name, cardId: card.id } }).then(ok => { if (ok) setName(''); }); }}>
        <input aria-label="新标签名称" value={name} maxLength={240} required disabled={blocked} onChange={e => setName(e.target.value)} />
        <button disabled={blocked || !name}>创建标签</button>
      </form>
      {notice && <p className="tag-notice" aria-live="polite">{notice}</p>}
      {confirmation && <section className="tag-confirm" role="alertdialog" aria-label="删除项目标签" onKeyDown={e => { if (e.key === 'Escape' && !isCompositionKey(e)) { e.preventDefault(); e.stopPropagation(); setConfirmation(null); deleteTrigger.current?.focus(); } }}>
        <strong>删除「{confirmation.tag.name}」标签？</strong><p>将从 {confirmation.count} 张卡片中移除，卡片内容保留。可以统一撤销恢复。</p>
        <button type="button" autoFocus onClick={() => { setConfirmation(null); deleteTrigger.current?.focus(); }}>取消删除标签</button>
        <button type="button" disabled={blocked} onClick={() => void confirmDelete()}>确认删除标签</button>
      </section>}
    </section>}
    {deletedAction && state.tags?.find(t => t.id === deletedAction.tagId)?.deleted && <div className="tag-deleted-notice" aria-live="polite"><p>已删除标签：{deletedAction.name}</p><button type="button" disabled={blocked} aria-label="撤销标签删除" onClick={() => undo(deletedAction.id)}>撤销</button></div>}
  </section>;
}
