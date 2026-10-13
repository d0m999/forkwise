import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Card, Change, Command, HistoryAction, Project, ProjectHistory } from './contracts.js';
import { requireThat } from '../domain/errors.js';

interface StoredAction extends HistoryAction {
  before: Card | Project | null;
  after: Card | Project;
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
  if (command.type === 'project.create' || !change.after) return;
  const stack = load(db, command.projectId);
  const after = change.after;
  const previous = stack.undo.at(-1);
  const editGroup = 'editGroup' in command ? command.editGroup : undefined;
  if (
    editGroup &&
    previous?.editGroup === editGroup &&
    previous.session === session &&
    previous.actor.id === change.actor.id &&
    previous.actor.type === change.actor.type &&
    previous.target.id === after.id &&
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
          JSON.stringify(before.body.blocks) === JSON.stringify(after.body.blocks)))
    )
      stack.undo.pop();
  } else
    stack.undo.push({
      session,
      lastRevision: change.revision,
      ...(editGroup ? { editGroup } : {}),
      id: command.commandId,
      label: command.type,
      target: { id: after.id, title: 'body' in after ? after.title : after.name },
      actor: change.actor,
      before: change.before,
      after,
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
) {
  const stack = load(db, project.id);
  const from = type === 'history.undo' ? stack.undo : stack.redo;
  const action = from.pop();
  requireThat(action, 'HISTORY_EMPTY', '没有可撤销或重做的操作', 409);
  const desired = type === 'history.undo' ? action.before : action.after;
  const row = db
    .prepare('SELECT value FROM mapping_cards WHERE id=? AND project_id=?')
    .get(action.target.id, project.id) as { value: string } | undefined;
  const before = 'body' in action.after ? (row ? (JSON.parse(row.value) as Card) : null) : project;
  let after: Card | Project | null = desired ? structuredClone(desired) : null;
  if (after && 'body' in after) {
    if (before && 'body' in before) {
      if (!action.changedIds.includes(after.id)) {
        after.title = before.title;
        after.versionId = before.versionId;
      }
      if (!action.changedIds.includes(after.body.id)) after.body = before.body;
      if (!action.changedIds.includes(after.item.id)) after.item = before.item;
    }
    if (action.changedIds.includes(after.id)) after.versionId = randomUUID();
    if (action.changedIds.includes(after.body.id)) after.body.versionId = randomUUID();
    if (action.changedIds.includes(after.item.id)) after.item.versionId = randomUUID();
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
  return {
    before,
    after,
    changedIds: action.changedIds,
    deletedIds: after ? [] : action.changedIds,
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
      (command.type === 'thought.title' && previous.label === 'thought.create'))
  )
    return;
  delete previous.editGroup;
  save(db, command.projectId, stack);
}
