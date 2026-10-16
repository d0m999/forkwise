import type Database from 'better-sqlite3';
import type { Card, Command } from './contracts.js';
import { requireThat } from '../domain/errors.js';

export function deleteCard(db: Database.Database, command: Extract<Command, { type: 'thought.delete' }>) {
  const row = db.prepare('SELECT value FROM mapping_cards WHERE id=? AND project_id=?').get(command.payload.id, command.projectId) as { value: string } | undefined;
  requireThat(row, 'NOT_FOUND', '卡片不存在于当前项目', 404);
  const card = JSON.parse(row.value) as Card;
  const expected = command.expected;
  requireThat(expected.thought === card.versionId && expected.body === card.body.versionId && expected.pose === card.item.versionId && expected.appearance === (card.appearance?.versionId ?? null) && (expected.cardTags ?? null) === (card.cardTags?.versionId ?? null), 'VERSION_CONFLICT', '删除依据已更新，请重新读取', 409);
  // Identity, creation ordinal and immutable versions are retained. No asset or
  // legacy research data is touched; future relations extend this atomic set.
  db.prepare('DELETE FROM mapping_cards WHERE id=? AND project_id=?').run(card.id, command.projectId);
  return { before: card, after: null, changedIds: [card.id, card.body.id, card.item.id, ...(card.appearance ? [card.appearance.id] : []), ...(card.cardTags ? [card.cardTags.id] : [])] };
}
