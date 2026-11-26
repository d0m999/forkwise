import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from './api';

export function AddAttachmentButton({ blocked, onAdd }: { blocked: boolean; onAdd: (file: File) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  return <>
    <button type="button" disabled={blocked} aria-label="添加附件" onClick={event => {
      event.stopPropagation();
      picker.current?.click();
    }}>添加附件</button>
    <input ref={picker} type="file" hidden disabled={blocked} onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (file && !blocked) onAdd(file);
    }} />
  </>;
}

type Attachment = NonNullable<Card['attachments']>['items'][number];

function CopyAttachmentDialog({ item, targets, blocked, onCopy, close }: {
  item: Attachment;
  targets: Card[];
  blocked: boolean;
  onCopy: (targetId: string) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [targetId, setTargetId] = useState('');
  const canCopy = !blocked && targets.some(target => target.id === targetId);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  const titles = new Set<string>(), repeated = new Set<string>();
  for (const target of targets) {
    const title = target.title || '未命名卡片';
    if (titles.has(title)) repeated.add(title);
    titles.add(title);
  }
  return createPortal(
    <dialog ref={dialog} className="attachment-copy-dialog" aria-label="复制附件到卡片"
      onCancel={event => { event.preventDefault(); close(); }}
      onKeyDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onPaste={event => event.stopPropagation()}>
      <form onSubmit={event => {
        event.preventDefault();
        if (canCopy) { onCopy(targetId); close(); }
      }}>
        <strong>复制附件到卡片</strong>
        <span>{item.name}</span>
        <label>目标卡片
          <select value={targetId} onChange={event => setTargetId(event.currentTarget.value)}>
            <option value="">{targets.length ? '请选择卡片' : '项目中没有可选卡片'}</option>
            {targets.map((target, index) => {
              const title = target.title || '未命名卡片';
              const { x, y } = target.item.pose;
              const location = repeated.has(title) ? `（第 ${index + 1} 张，位置 ${Math.round(x)}, ${Math.round(y)}）` : '';
              return <option key={target.id} value={target.id}>{title}{location}</option>;
            })}
          </select>
        </label>
        <div><button type="button" onClick={close}>取消</button> <button disabled={!canCopy}>复制</button></div>
      </form>
    </dialog>,
    document.body,
  );
}

export function CardAttachmentList({ card, projectCards, blocked, writeBlocked, onOpen, onRemove, onAdd, onCopy, showAddWhenEmpty = false }: {
  card: Card;
  projectCards: Card[];
  blocked: boolean;
  writeBlocked: boolean;
  onOpen: (assetId: string) => void;
  onRemove: (attachmentId: string) => void;
  onAdd: (file: File) => void;
  onCopy: (targetId: string, item: Attachment) => void;
  showAddWhenEmpty?: boolean;
}) {
  const items = card.attachments?.items ?? [];
  const [expanded, setExpanded] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const [copyId, setCopyId] = useState<string | null>(null);
  const copying = items.find(item => item.id === copyId);
  if (!items.length && !showAddWhenEmpty) return null;
  const visible = expanded ? items : items.slice(0, 3);
  return (
    <div
      className="card-attachments nodrag nopan"
      role="group"
      aria-label="卡片附件"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !expanded) return;
        event.preventDefault();
        event.stopPropagation();
        setExpanded(false);
        more.current?.focus();
      }}
    >
      {visible.map(item => (
        <div className="card-attachment-row" key={item.id}>
          <button type="button" className="card-attachment-name" disabled={blocked}
            aria-label={`打开 ${item.name}`} onClick={event => { event.stopPropagation(); onOpen(item.assetId); }}>{item.name}</button>
          <div className="card-attachment-actions">
            <button type="button" aria-disabled={writeBlocked} aria-label={`复制 ${item.name} 到其他卡片`} onClick={event => {
              event.stopPropagation();
              if (!writeBlocked) setCopyId(item.id);
            }}>复制到…</button>
            <button type="button" disabled={writeBlocked} aria-label={`解除 ${item.name}`} onClick={event => { event.stopPropagation(); onRemove(item.id); }}>解除</button>
          </div>
        </div>
      ))}
      {items.length > 3 && <button ref={more} type="button" aria-label={expanded ? '收起附件' : `还有 ${items.length - 3} 项`} onClick={(event) => { event.stopPropagation(); setExpanded(value => !value); }}>{expanded ? '收起' : `还有 ${items.length - 3} 项`}</button>}
      <AddAttachmentButton blocked={writeBlocked} onAdd={onAdd} />
      {copying && <CopyAttachmentDialog item={copying} blocked={writeBlocked}
        targets={projectCards.filter(target => target.id !== card.id && !target.attachments?.items.some(item => item.assetId === copying.assetId))}
        onCopy={targetId => onCopy(targetId, copying)} close={() => setCopyId(null)} />}
    </div>
  );
}
