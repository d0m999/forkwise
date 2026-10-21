import { restoreText } from './text.js';
import { restoreShape } from './shape.js';
import { restoreStroke } from './stroke.js';
import { imageTask } from './media-blocks.js';
import { retainCardVersions } from './versions.js';
import { DEFAULT_APPEARANCE } from './presentation-values.js';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Card, Change, Command, HistoryAction, Project, ProjectHistory } from './contracts.js';
import { requireThat } from '../domain/errors.js';
import { restoreGeometry } from './geometry.js';
import { bodyContentUnchanged } from './body.js';
import { restoreTag, restoreTagCards } from './tags.js';

interface StoredAction extends HistoryAction {
  strokeChange?: Change['strokeChange'];
  shapeChange?: Change['shapeChange'];
  shapeChanges?: Change['shapeChanges'];
  textChange?: Change['textChange'];
  textChanges?: Change['textChanges'];
  tagChange?: Change['tagChange'];
  cardChanges?: Change['cardChanges'];
  before: Card | Project | null;
  after: Card | Project | null;
  changedIds: string[];
  editGroup?: string;
  lastRevision: number;
  session: string;
}
interface Stack {
  undo: StoredAction[];
  redo: StoredAction[];
}
export function initializeHistory(db: Database.Database) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS mapping_history(project_id TEXT PRIMARY KEY REFERENCES mapping_projects(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mapping_card_ids(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES mapping_projects(id));
      INSERT OR IGNORE INTO mapping_card_ids SELECT id,project_id FROM mapping_cards ORDER BY rowid;`);
  }).immediate();
}
function load(db: Database.Database, id: string): Stack {
  const row = db.prepare('SELECT value FROM mapping_history WHERE project_id=?').get(id) as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as Stack) : { undo: [], redo: [] };
}
function save(db: Database.Database, id: string, stack: Stack) {
  db.prepare(
    'INSERT INTO mapping_history VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET value=excluded.value',
  ).run(id, JSON.stringify(stack));
}
export function readHistory(db: Database.Database, project: Project): ProjectHistory {
  const stack = load(db, project.id);
  const summary = ({ id, label, target, actor }: StoredAction): HistoryAction => ({
    id,
    label,
    target,
    actor,
  });
  return {
    revision: project.revision,
    undo: stack.undo.map(summary),
    redo: stack.redo.map(summary),
  };
}
export function recordAction(
  db: Database.Database,
  command: Command,
  change: Change,
  session: string,
) {
  if (command.type === 'project.create') return;
  const stack = load(db, command.projectId);
  if (change.strokeChange) {
    const value = change.strokeChange.after ?? change.strokeChange.before!;
    stack.undo.push({ session, lastRevision: change.revision, id: command.commandId, label: command.type,
      target: { id: value.id, title: value.content.penKind === 'highlighter' ? '荧光笔' : '笔迹' },
      actor: change.actor, before: null, after: null, strokeChange: change.strokeChange, changedIds: change.changedIds });
    stack.undo = stack.undo.slice(-40); stack.redo = []; save(db, command.projectId, stack); return;
  }
  if (change.shapeChange) {
    const value = change.shapeChange.after ?? change.shapeChange.before!;
    stack.undo.push({ session, lastRevision: change.revision, id: command.commandId, label: command.type,
      target: { id: value.id, title: value.content.shortText }, actor: change.actor, before: null, after: null,
      shapeChange: change.shapeChange, changedIds: change.changedIds });
    stack.undo = stack.undo.slice(-40);
    stack.redo = [];
    save(db, command.projectId, stack);
    return;
  }
  if (command.type === 'canvas.move') {
    const target = change.cardChanges?.[0]?.after ?? change.textChanges?.[0]?.after ?? change.shapeChanges?.[0]?.after;
    if (!target) return;
    stack.undo.push({ session, lastRevision: change.revision, id: command.commandId, label: command.type, target: { id: target.id, title: 'title' in target ? target.title : 'shortText' in target.content ? target.content.shortText : target.content.runs.map(run => run.text).join('') }, actor: change.actor, before: null, after: null, cardChanges: change.cardChanges ?? [], textChanges: change.textChanges ?? [], shapeChanges: change.shapeChanges ?? [], changedIds: change.changedIds });
    stack.undo = stack.undo.slice(-40); stack.redo = []; save(db, command.projectId, stack); return;
  }
  if (change.textChange) {
    const value = change.textChange.after ?? change.textChange.before!;
    const previous = stack.undo.at(-1);
    if (command.type === 'text.layout') {
      if (previous?.lastRevision === change.revision - 1) {
        previous.lastRevision = change.revision;
        if (previous.textChange?.after?.id === value.id) {
          previous.textChange.after.item = value.item;
          previous.changedIds = [...new Set([...previous.changedIds, value.item.id])];
        }
      }
      save(db, command.projectId, stack); return;
    }
    const editGroup = 'editGroup' in command ? command.editGroup : undefined;
    if (editGroup && previous?.editGroup === editGroup && previous.session === session && previous.actor.id === change.actor.id && previous.target.id === value.id && previous.lastRevision === change.revision - 1 && !stack.redo.length && (previous.label === command.type || (previous.label === 'text.create' && command.type === 'text.edit') || (previous.label === 'text.edit' && command.type === 'text.delete'))) {
      previous.textChange!.after = change.textChange.after;
      previous.changedIds = [...new Set([...previous.changedIds, ...change.changedIds])];
      previous.lastRevision = change.revision;
      previous.target.title = value.content.runs.map(run => run.text).join('');
    } else stack.undo.push({ session, lastRevision: change.revision, ...(editGroup ? { editGroup } : {}), id: command.commandId, label: command.type, target: { id: value.id, title: value.content.runs.map(run => run.text).join('') }, actor: change.actor, before: null, after: null, textChange: change.textChange, changedIds: change.changedIds });
    stack.undo = stack.undo.slice(-40); stack.redo = [];
    save(db, command.projectId, stack);
    return;
  }
  const after = change.after;
  const target = change.tagChange?.after ?? after ?? change.before;
  if (!target) return;
  const previous = stack.undo.at(-1);
  if (command.type === 'card.layout') {
    // Measured presentation is derived state, not another research action.
    // It must not split a title/create typing group on the project timeline.
    if (previous?.lastRevision === change.revision - 1) {
      previous.lastRevision = change.revision;
      // Recreating this action must restore its measured projection rather than
      // the unmeasured creation placeholder. It remains one create/title step.
      if (
        previous.after && after && 'body' in previous.after &&
        'body' in after &&
        previous.after.id === after.id &&
        previous.changedIds.includes(after.item.id)
      )
        previous.after.item = after.item;
    }
    save(db, command.projectId, stack);
    return;
  }
  const editGroup = 'editGroup' in command ? command.editGroup : undefined;
  if (
    editGroup &&
    previous?.editGroup === editGroup &&
    previous.session === session &&
    previous.actor.id === change.actor.id &&
    previous.actor.type === change.actor.type &&
    after && previous.target.id === after.id &&
    (previous.label === command.type ||
      (previous.label === 'thought.create' && command.type === 'thought.title')) &&
    previous.lastRevision === change.revision - 1 &&
    !stack.redo.length
  ) {
    previous.after = after;
    previous.lastRevision = change.revision;
    previous.target.title = 'body' in after ? after.title : after.name;
    const before = previous.before;
    if (
      before &&
      'body' in before &&
      'body' in after &&
      ((command.type === 'thought.title' &&
        previous.label === 'thought.title' &&
        before.title === after.title) ||
        (command.type === 'body.edit' &&
          bodyContentUnchanged(before.body.blocks, after.body.blocks)))
    )
      stack.undo.pop();
  } else
    stack.undo.push({
      session,
      lastRevision: change.revision,
      ...(editGroup ? { editGroup } : {}),
      id: command.commandId,
      label: command.type,
      target: { id: target.id, title: 'body' in target ? target.title : target.name },
      actor: change.actor,
      before: change.before,
      after,
      ...(change.tagChange ? { tagChange: change.tagChange } : {}),
      ...(change.cardChanges ? { cardChanges: change.cardChanges } : {}),
      changedIds: change.changedIds,
    });
  stack.undo = stack.undo.slice(-40);
  stack.redo = [];
  save(db, command.projectId, stack);
}
export function travelHistory(
  db: Database.Database,
  project: Project,
  type: 'history.undo' | 'history.redo',
  actionId?: string,
) {
  const stack = load(db, project.id);
  const from = type === 'history.undo' ? stack.undo : stack.redo;
  requireThat(!actionId || from.at(-1)?.id === actionId, 'HISTORY_TARGET_CHANGED', '历史目标已变化，不能撤销其他操作', 409);
  const action = from.pop();
  requireThat(action, 'HISTORY_EMPTY', '没有可撤销或重做的操作', 409);
  if (action.strokeChange) {
    const strokeChange = restoreStroke(db, project.id, action.strokeChange, type);
    (type === 'history.undo' ? stack.redo : stack.undo).push(action);
    save(db, project.id, stack);
    return { before: null, after: null, strokeChange, changedIds: action.changedIds,
      deletedIds: strokeChange.after ? [] : action.changedIds, target: { ...action.target, label: action.label } };
  }
  if (action.shapeChange) {
    const shapeChange = restoreShape(db, project.id, action.shapeChange, type);
    (type === 'history.undo' ? stack.redo : stack.undo).push(action);
    save(db, project.id, stack);
    return { before: null, after: null, shapeChange, changedIds: action.changedIds,
      deletedIds: shapeChange.after ? [] : action.changedIds, target: { ...action.target, label: action.label } };
  }
  if (action.textChanges || action.shapeChanges) {
    const textChanges = (action.textChanges ?? []).map(change => restoreText(db, project.id, change, type));
    const shapeChanges = (action.shapeChanges ?? []).map(change => restoreShape(db, project.id, change, type));
    const cardChanges = restoreGeometry(db, project.id, action.cardChanges ?? [], type);
    (type === 'history.undo' ? stack.redo : stack.undo).push(action); save(db, project.id, stack);
    return { before: null, after: null, cardChanges, textChanges, shapeChanges, changedIds: action.changedIds, deletedIds: [], target: { ...action.target, label: action.label } };
  }
  if (action.textChange) {
    const textChange = restoreText(db, project.id, action.textChange, type);
    (type === 'history.undo' ? stack.redo : stack.undo).push(action);
    save(db, project.id, stack);
    const { before, after } = textChange;
    const identity = after ?? before!;
    const changedIds = [
      ...(!before || !after || before.versionId !== after.versionId ? [identity.id] : []),
      ...(!before || !after || before.item.versionId !== after.item.versionId ? [identity.item.id] : []),
    ];
    return { before: null, after: null, textChange, changedIds, deletedIds: after ? [] : changedIds, target: { ...action.target, label: action.label } };
  }
  const desired = type === 'history.undo' ? action.before : action.after;
  if (action.tagChange) {
    const tagChange = restoreTag(db, project.id, action.tagChange, type);
    const cardChanges = action.cardChanges ? restoreTagCards(db, project.id, action.cardChanges, type) : undefined;
    (type === 'history.undo' ? stack.redo : stack.undo).push(action);
    save(db, project.id, stack);
    return { before: null, after: null, tagChange, cardChanges, changedIds: action.changedIds, deletedIds: tagChange.after.deleted ? [tagChange.after.id] : [], target: { ...action.target, label: action.label } };
  }
  if (action.cardChanges) {
    const cardChanges = restoreGeometry(db, project.id, action.cardChanges, type);
    (type === 'history.undo' ? stack.redo : stack.undo).push(action);
    save(db, project.id, stack);
    return {
      before: cardChanges[0]!.before,
      after: cardChanges[0]!.after,
      cardChanges,
      changedIds: action.changedIds,
      deletedIds: [],
      target: { ...action.target, label: action.label },
    };
  }
  const row = db
    .prepare('SELECT value FROM mapping_cards WHERE id=? AND project_id=?')
    .get(action.target.id, project.id) as { value: string } | undefined;
  const identity = action.after ?? action.before!;
  const before = 'body' in identity ? (row ? (JSON.parse(row.value) as Card) : null) : project;
  let after: Card | Project | null = desired ? structuredClone(desired) : null;
  if (after && 'body' in after) {
    if (before && 'body' in before) {
      if (!action.changedIds.includes(after.id)) {
        after.title = before.title;
        after.versionId = before.versionId;
      }
      if (!action.changedIds.includes(after.body.id)) after.body = before.body;
      if (!action.changedIds.includes(after.item.id)) after.item = before.item;
      if (!action.changedIds.includes(`cardTags:${after.id}`)) {
        if (before.cardTags) after.cardTags = before.cardTags;
        else delete after.cardTags;
      }
      if (!action.changedIds.includes(`appearance:${after.id}`)) {
        if (before.appearance) after.appearance = before.appearance;
        else delete after.appearance;
      }
    }
    if (action.changedIds.includes(after.id)) after.versionId = randomUUID();
    if (action.changedIds.includes(after.body.id)) after.body.versionId = randomUUID();
    if (action.changedIds.includes(after.item.id)) after.item.versionId = randomUUID();
    const restoringIdentity = !before && action.changedIds.includes(after.id);
    if (action.changedIds.includes(`cardTags:${after.id}`) || (restoringIdentity && (after.cardTags || db.prepare("SELECT 1 FROM mapping_versions WHERE project_id=? AND domain='cardTags' AND id=? LIMIT 1").get(project.id, `cardTags:${after.id}`))))
      after.cardTags = { id: `cardTags:${after.id}`, tagIds: after.cardTags?.tagIds ?? [], versionId: randomUUID() };
    const appearanceId = `appearance:${after.id}`;
    if (
      action.changedIds.includes(appearanceId) ||
      (restoringIdentity &&
        db
          .prepare(
            "SELECT 1 FROM mapping_versions WHERE project_id=? AND domain='appearance' AND id=? LIMIT 1",
          )
          .get(project.id, appearanceId))
    ) {
      after.appearance = {
        ...(after.appearance ?? { id: appearanceId, ...DEFAULT_APPEARANCE }),
        versionId: randomUUID(),
      };
    }
    db.prepare(
      'INSERT INTO mapping_cards VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
    ).run(after.id, project.id, JSON.stringify(after));
  } else if (after) {
    after.versionId = randomUUID();
    after.revision = project.revision + 1;
    db.prepare('UPDATE mapping_projects SET name=?,version_id=? WHERE id=?').run(
      after.name,
      after.versionId,
      project.id,
    );
  } else
    db.prepare('DELETE FROM mapping_cards WHERE id=? AND project_id=?').run(
      action.target.id,
      project.id,
    );
  (type === 'history.undo' ? stack.redo : stack.undo).push(action);
  save(db, project.id, stack);
  const lifecycleAppearance =
    (!before || !after) && 'body' in identity
      ? ((before && 'body' in before ? before.appearance?.id : undefined) ??
        (after && 'body' in after ? after.appearance?.id : undefined))
      : undefined;
  const changedIds = [
    ...new Set([...action.changedIds, ...(lifecycleAppearance ? [lifecycleAppearance] : []), ...((!before || !after) && 'body' in identity ? [before && 'body' in before ? before.cardTags?.id : undefined, after && 'body' in after ? after.cardTags?.id : undefined].filter((id): id is string => !!id) : [])]),
  ];
  return {
    before,
    after,
    changedIds,
    deletedIds: after ? [] : changedIds,
    target: { ...action.target, label: action.label },
  };
}

// A no-op is not a history entry, but a different command still closes typing.
export function interruptGroup(db: Database.Database, command: Command, session: string) {
  const stack = load(db, command.projectId);
  const previous = stack.undo.at(-1);
  if (!previous?.editGroup) return;
  if (
    'editGroup' in command &&
    command.editGroup === previous.editGroup &&
    session === previous.session &&
    'id' in command.payload &&
    command.payload.id === previous.target.id &&
    (command.type === previous.label ||
      (command.type === 'thought.title' && previous.label === 'thought.create') ||
      (command.type === 'text.edit' && previous.label === 'text.create'))
  )
    return;
  delete previous.editGroup;
  save(db, command.projectId, stack);
}

// Async completion belongs to the original insertion/replacement action, even
// when another card has since been edited. Preserve the chronological stack;
// replace only snapshots that still carry that exact request ticket.
export function completeMediaHistory(
  db: Database.Database,
  projectId: string,
  cardId: string,
  ticket: string,
  replacement: import('./contracts.js').Block,
  revision: number,
) {
  const stack = load(db, projectId);
  const update = (card: Card | Project | null) => {
    if (!card || !('body' in card) || card.id !== cardId) return;
    let changed = false;
    card.body.blocks = card.body.blocks.map((block) => {
      if (imageTask(block)?.ticket !== ticket) return block;
      changed = true;
      if (replacement.type === 'image' && !imageTask(replacement)) {
        const { request, ...prior } = block;
        const identity =
          block.type === 'image'
            ? prior
            : {
                id: block.id,
                type: 'image',
                ...(block.inlineId ? { inlineId: block.inlineId } : {}),
              };
        return {
          ...identity,
          assetId: replacement.assetId,
          name: replacement.name,
          mime: replacement.mime,
          naturalWidth: replacement.naturalWidth,
          naturalHeight: replacement.naturalHeight,
        };
      }
      const task = structuredClone(imageTask(replacement)!);
      if (block.type === 'image') return { ...block, request: task };
      const { inlineId, ...content } = task;
      return { ...content, id: block.id, ...(block.inlineId ? { inlineId: block.inlineId } : {}) };
    });
    if (changed) {
      card.body.versionId = randomUUID();
      retainCardVersions(db, projectId, card);
    }
  };
  for (const action of [...stack.undo, ...stack.redo]) {
    update(action.before);
    update(action.after);
    for (const change of action.cardChanges ?? []) {
      update(change.before);
      update(change.after);
    }
  }
  const latest=stack.undo.at(-1);
  if(latest?.lastRevision===revision-1)latest.lastRevision=revision;
  save(db, projectId, stack);
}
