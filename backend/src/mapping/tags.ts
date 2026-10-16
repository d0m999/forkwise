import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Card, Command, Tag, Change } from './contracts.js';
import { canonical } from '../domain/canonical.js';
import { requireThat } from '../domain/errors.js';

export function initializeTags(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS mapping_tags(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id), value TEXT NOT NULL)');
}
export function readTags(db: Database.Database, projectId: string): Tag[] {
  return (db.prepare('SELECT value FROM mapping_tags WHERE project_id=? ORDER BY id').all(projectId) as { value: string }[]).map(r => JSON.parse(r.value) as Tag);
}
export function saveTag(db: Database.Database, projectId: string, tag: Tag) {
  db.prepare('INSERT INTO mapping_tags VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(tag.id, projectId, JSON.stringify(tag));
  db.prepare('INSERT OR IGNORE INTO mapping_versions VALUES(?,?,?,?,?)').run(projectId, 'tag', tag.id, tag.versionId, JSON.stringify(tag));
}
export function createTag(db: Database.Database, projectId: string, payload: { id: string; name: string }) {
  const existing = readTags(db, projectId).find(t => !t.deleted && t.name.toLowerCase() === payload.name.toLowerCase());
  if (existing) return null;
  requireThat(!db.prepare('SELECT 1 FROM mapping_tags WHERE id=?').get(payload.id), 'ID_CONFLICT', '标签身份已使用', 409);
  const after: Tag = { id: payload.id, name: payload.name, color: '#f1f0ec', deleted: false, versionId: randomUUID() };
  saveTag(db, projectId, after);
  return { before: null, after };
}
export function updateTag(db: Database.Database, command: Extract<Command, { type: 'tag.update' }>) {
  const tags = readTags(db, command.projectId), before = tags.find(t => t.id === command.payload.id && !t.deleted);
  requireThat(before, 'NOT_FOUND', '标签不存在于当前项目', 404);
  requireThat(before.versionId === command.expected, 'VERSION_CONFLICT', '标签已更新，请重新读取', 409);
  const name = command.payload.name ?? before.name;
  requireThat(!tags.some(t => !t.deleted && t.id !== before.id && t.name.toLowerCase() === name.toLowerCase()), 'TAG_NAME_CONFLICT', '标签名称重复，请更换名称', 409);
  const color = command.payload.color && command.payload.color.toLowerCase() !== before.color.toLowerCase() ? command.payload.color : before.color;
  if (name === before.name && color === before.color) return null;
  const after: Tag = { ...before, name, color, versionId: randomUUID() };
  saveTag(db, command.projectId, after);
  return { before, after };
}
export function writeCardTags(db: Database.Database, command: Extract<Command, { type: 'card.tags' }>) {
  const row = db.prepare('SELECT value FROM mapping_cards WHERE id=? AND project_id=?').get(command.payload.id, command.projectId) as { value: string } | undefined;
  requireThat(row, 'NOT_FOUND', '卡片不存在于当前项目', 404);
  const before = JSON.parse(row.value) as Card;
  requireThat((before.cardTags?.versionId ?? null) === command.expected, 'VERSION_CONFLICT', '卡片标签已更新，请重新读取', 409);
  const ids = command.payload.tagIds;
  requireThat(new Set(ids).size === ids.length, 'INVALID_TAGS', '标签关联不能重复', 400);
  const tags = readTags(db, command.projectId);
  requireThat(ids.every(id => tags.some(t => t.id === id && !t.deleted)), 'NOT_FOUND', '标签不存在于当前项目', 404);
  if (canonical(ids) === canonical(before.cardTags?.tagIds ?? [])) return null;
  const after = { ...before, cardTags: { id: `cardTags:${before.id}`, versionId: randomUUID(), tagIds: ids } };
  db.prepare('UPDATE mapping_cards SET value=? WHERE id=? AND project_id=?').run(JSON.stringify(after), after.id, command.projectId);
  return { before, after, changedIds: [after.cardTags.id] };
}
export function createTagSelection(db: Database.Database, command: Extract<Command, { type: 'tag.create' }>) {
  const { cardId } = command.payload;
  requireThat(cardId ? command.expected !== null : command.expected === null, 'EXPECTED_DOMAINS', '创建并添加标签须提供当前卡片关联版本', 409);
  const tagChange = createTag(db, command.projectId, command.payload);
  const tag = tagChange?.after ?? readTags(db, command.projectId).find(t => !t.deleted && t.name.toLowerCase() === command.payload.name.toLowerCase())!;
  let cardChange: ReturnType<typeof writeCardTags> = null;
  if (cardId) {
    requireThat(command.expected, 'EXPECTED_DOMAINS', '须重新读取卡片标签', 409);
    const row = db.prepare('SELECT value FROM mapping_cards WHERE id=? AND project_id=?').get(cardId, command.projectId) as { value: string } | undefined;
    requireThat(row, 'NOT_FOUND', '卡片不存在于当前项目', 404);
    const card = JSON.parse(row.value) as Card;
    cardChange = writeCardTags(db, { ...command, type: 'card.tags', expected: command.expected.cardTags, payload: { id: cardId, tagIds: [...new Set([...(card.cardTags?.tagIds ?? []), tag.id])] } });
  }
  return { tagChange, cardChange, changedIds: [...(tagChange ? [tag.id] : []), ...(cardChange?.changedIds ?? [])] };
}
export function restoreTag(db: Database.Database, projectId: string, change: NonNullable<Change['tagChange']>, direction: 'history.undo' | 'history.redo') {
  const tags = readTags(db, projectId), before = tags.find(t => t.id === change.after.id)!;
  const desired = direction === 'history.undo' ? change.before : change.after;
  const after = { ...(desired ?? change.after), deleted: desired ? desired.deleted : true, versionId: randomUUID() };
  requireThat(after.deleted || !tags.some(t => !t.deleted && t.id !== after.id && t.name.toLowerCase() === after.name.toLowerCase()), 'TAG_NAME_CONFLICT', '恢复的标签名称重复', 409);
  saveTag(db, projectId, after);
  return { before, after };
}
export function deleteTag(db: Database.Database, command: Extract<Command, { type: 'tag.delete' }>) {
  const before = readTags(db, command.projectId).find(t => t.id === command.payload.id && !t.deleted);
  requireThat(before, 'NOT_FOUND', '标签已不存在，请重新读取并重新确认', 409);
  const cards = (db.prepare('SELECT value FROM mapping_cards WHERE project_id=? ORDER BY rowid').all(command.projectId) as { value: string }[]).map(r => JSON.parse(r.value) as Card).filter(c => c.cardTags?.tagIds.includes(before.id));
  const range = Object.fromEntries(cards.map(c => [c.id, c.cardTags!.versionId]));
  requireThat(command.expected.tag === before.versionId && canonical(range) === canonical(command.expected.cardTags), 'VERSION_CONFLICT', '标签或受影响卡片已变化，请重新读取并重新确认', 409);
  const after = { ...before, deleted: true, versionId: randomUUID() };
  const cardChanges = cards.map(before => ({ before, after: { ...before, cardTags: { ...before.cardTags!, tagIds: before.cardTags!.tagIds.filter(id => id !== after.id), versionId: randomUUID() } } }));
  saveTag(db, command.projectId, after);
  for (const c of cardChanges) db.prepare('UPDATE mapping_cards SET value=? WHERE id=? AND project_id=?').run(JSON.stringify(c.after), c.after.id, command.projectId);
  return { tagChange: { before, after }, cardChanges, changedIds: [after.id, ...cardChanges.map(c => c.after.cardTags.id)] };
}
export function restoreTagCards(db: Database.Database, projectId: string, changes: NonNullable<Change['cardChanges']>, direction: 'history.undo' | 'history.redo') {
  return changes.map(change => {
    const desired = direction === 'history.undo' ? change.before : change.after;
    const row = db.prepare('SELECT value FROM mapping_cards WHERE id=? AND project_id=?').get(desired.id, projectId) as { value: string } | undefined;
    requireThat(row, 'NOT_FOUND', '标签历史的卡片已不可用', 409);
    const before = JSON.parse(row.value) as Card;
    const after = { ...before, cardTags: { id: `cardTags:${desired.id}`, tagIds: desired.cardTags?.tagIds ?? [], versionId: randomUUID() } };
    db.prepare('UPDATE mapping_cards SET value=? WHERE id=? AND project_id=?').run(JSON.stringify(after), after.id, projectId);
    return { before, after };
  });
}
