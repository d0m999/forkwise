import { useRef, useState } from 'react';
import type { Card } from './api';

export function CardAttachmentList({ card, blocked, onOpen, onRemove, onAdd }: {
  card: Card;
  blocked: boolean;
  onOpen: (assetId: string) => void;
  onRemove: (attachmentId: string) => void;
  onAdd: (file: File) => void;
}) {
  const items = card.attachments?.items ?? [];
  const [expanded, setExpanded] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  if (!card.attachments) return null;
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
        <span key={item.id}>
          <button type="button" disabled={blocked} aria-label={`打开 ${item.name}`} onClick={(event) => { event.stopPropagation(); onOpen(item.assetId); }}>{item.name}</button>
          <button type="button" disabled={blocked} aria-label={`解除 ${item.name}`} onClick={(event) => { event.stopPropagation(); onRemove(item.id); }}>解除</button>
        </span>
      ))}
      {items.length > 3 && <button ref={more} type="button" aria-label={expanded ? '收起附件' : `还有 ${items.length - 3} 项`} onClick={(event) => { event.stopPropagation(); setExpanded(value => !value); }}>{expanded ? '收起' : `还有 ${items.length - 3} 项`}</button>}
      <button type="button" disabled={blocked} aria-label="添加附件" onClick={(event) => { event.stopPropagation(); picker.current?.click(); }}>添加附件</button>
      <input ref={picker} type="file" hidden disabled={blocked} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) onAdd(file); }} />
    </div>
  );
}
