import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Card, Command } from './contracts.js';
import type { CardAttachmentItem, CardAttachmentSet } from './card-attachment-contracts.js';
import { canonical } from '../domain/canonical.js';
import { requireThat } from '../domain/errors.js';

function readCard(db: Database.Database, projectId: string, id: string) {
  const row = db.prepare('SELECT value FROM mapping_cards WHERE id=? AND project_id=?').get(id, projectId) as { value: string } | undefined;
  requireThat(row, 'NOT_FOUND', '卡片不存在于当前项目', 404);
  return JSON.parse(row.value) as Card;
}

function writeCard(db: Database.Database, projectId: string, card: Card) {
  db.prepare('UPDATE mapping_cards SET value=? WHERE id=? AND project_id=?').run(JSON.stringify(card), card.id, projectId);
}

export function readCardAttachments(db: Database.Database, projectId: string, cardId: string): CardAttachmentSet | null {
  return readCard(db, projectId, cardId).attachments ?? null;
}

function replaceItems(before: Card, items: CardAttachmentItem[]) {
  if (canonical(items) === canonical(before.attachments?.items ?? [])) return null;
  const after: Card = {
    ...before,
    attachments: { id: `attachments:${before.id}`, versionId: randomUUID(), items },
  };
  return after;
}

export function addCardAttachment(db: Database.Database, command: Extract<Command, { type: 'card.attachment.add' }>) {
  const before = readCard(db, command.projectId, command.payload.id);
  requireThat((before.attachments?.versionId ?? null) === command.expected.attachments, 'VERSION_CONFLICT', '卡片附件已更新，请重新读取', 409);
  requireThat(db.prepare('SELECT 1 FROM mapping_assets WHERE project_id=? AND id=?').get(command.projectId, command.payload.assetId), 'NOT_FOUND', '资产不存在于当前项目', 404);
  const items = before.attachments?.items ?? [];
  requireThat(!items.some(item => item.assetId === command.payload.assetId), 'INVALID_ATTACHMENT', '同一资产不能重复加入这张卡片', 400);
  const after = replaceItems(before, [...items, { id: randomUUID(), assetId: command.payload.assetId, name: command.payload.name }]);
  if (!after) return null;
  writeCard(db, command.projectId, after);
  return { before, after, changedIds: [after.attachments!.id] };
}

export function removeCardAttachment(db: Database.Database, command: Extract<Command, { type: 'card.attachment.remove' }>) {
  const before = readCard(db, command.projectId, command.payload.id);
  requireThat(before.attachments?.versionId === command.expected.attachments, 'VERSION_CONFLICT', '卡片附件已更新，请重新读取', 409);
  const items = before.attachments?.items ?? [];
  requireThat(items.some(item => item.id === command.payload.attachmentId), 'NOT_FOUND', '附件不属于这张卡片', 404);
  const after = replaceItems(before, items.filter(item => item.id !== command.payload.attachmentId));
  if (!after) return null;
  writeCard(db, command.projectId, after);
  return { before, after, changedIds: [after.attachments!.id] };
}
