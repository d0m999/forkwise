import type Database from 'better-sqlite3';
import type { Card, Change } from './contracts.js';
import { restoreGroups } from './group.js';
import { restoreCard } from './card-history.js';
import { restoreText } from './text.js';
import { restoreShape } from './shape.js';
import { restoreImage } from './image.js';
import { restoreStroke } from './stroke.js';
import { restoreConnector } from './connector.js';
import { groupOutcome } from './group-lifecycle.js';

type Action = Pick<Change, 'before' | 'after' | 'changedIds'> & { [K in keyof Change]?: Change[K] | undefined };
function unique<T extends { before: { id: string } | null; after: { id: string } | null }>(changes: T[]): T[] {
  return [...new Map(changes.map(change => [(change.after ?? change.before!).id, change])).values()];
}
export function restoreGroupAction(db: Database.Database, projectId: string, action: Action, type: 'history.undo' | 'history.redo') {
  const cards: { before: Card | null; after: Card | null }[] = [...(action.cardLifecycleChanges ?? [])];
  if (action.before && 'body' in action.before || action.after && 'body' in action.after)
    cards.push({ before: action.before && 'body' in action.before ? action.before : null, after: action.after && 'body' in action.after ? action.after : null });
  const cardLifecycleChanges = unique(cards).map(change => restoreCard(db, projectId, change, type, action.changedIds));
  const textChanges = unique([...(action.textChanges ?? []), ...(action.textChange ? [action.textChange] : [])]).map(change => restoreText(db, projectId, change, type));
  const shapeChanges = unique([...(action.shapeChanges ?? []), ...(action.shapeChange ? [action.shapeChange] : [])]).map(change => restoreShape(db, projectId, change, type));
  const imageChanges = unique([...(action.imageChanges ?? []), ...(action.imageChange ? [action.imageChange] : [])]).map(change => restoreImage(db, projectId, change, type));
  const strokeChanges = unique([...(action.strokeChanges ?? []), ...(action.strokeChange ? [action.strokeChange] : [])]).map(change => restoreStroke(db, projectId, change, type));
  const structural = restoreGroups(db, projectId, action.groupChanges ?? [], action.containmentChanges ?? [], type);
  const connectorChanges = unique(action.connectorChanges ?? []).map(change => restoreConnector(db, projectId, change, type));
  const changes = { before: null, after: null, ...structural, cardLifecycleChanges, textChanges, shapeChanges, imageChanges, strokeChanges, connectorChanges };
  return { ...changes, ...groupOutcome({ ...changes, changedIds: action.changedIds }) };
}
