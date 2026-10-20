import type Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import type { Command } from './contracts.js';
import type { SearchState } from './search-contracts.js';
import { requireThat } from '../domain/errors.js';
import { lexSearch, normalizeHistoryText } from './search-language.js';
import type { SearchConditions } from './search-contracts.js';
import { readTags } from './tags.js';

export function searchConditionIdentity(query: SearchConditions) {
  const pieces = lexSearch(query.text).pieces.map<[string, string, boolean]>(
    ({ text, phrase, closed }) => [phrase ? 'phrase' : 'text', normalizeHistoryText(text), closed],
  );
  const tagIds = [...new Set(query.tagIds)].sort();
  return {
    id: createHash('sha256')
      .update(JSON.stringify([pieces, tagIds]))
      .digest('hex'),
    nonempty: !!(pieces.length || tagIds.length),
  };
}

export function initializeSearchState(db: Database.Database) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS mapping_search_state(project_id TEXT PRIMARY KEY REFERENCES mapping_projects(id), value TEXT NOT NULL)',
  );
}

export function readSearchState(db: Database.Database, projectId: string): SearchState {
  const row = db
    .prepare('SELECT value FROM mapping_search_state WHERE project_id=?')
    .get(projectId) as { value: string } | undefined;
  return row
    ? (JSON.parse(row.value) as SearchState)
    : {
        projectId,
        versionId: null,
        current: { text: '', tagIds: [] },
        history: [],
        blockedIdentity: null,
        removed: null,
      };
}

export type SearchStateCommand = Extract<
  Command,
  { type: 'search.save' | 'search.record' | 'search.clear' | 'search.restore' | 'search.delete' }
>;
export function isSearchStateCommand(command: Command): command is SearchStateCommand {
  return (
    command.type === 'search.save' ||
    command.type === 'search.record' ||
    command.type === 'search.clear' ||
    command.type === 'search.restore' ||
    command.type === 'search.delete'
  );
}

export function saveSearchState(db: Database.Database, command: SearchStateCommand): SearchState {
  const state = readSearchState(db, command.projectId);
  requireThat(
    command.expected === state.versionId,
    'VERSION_CONFLICT',
    '搜索记录已更新，请重新读取后重试',
    409,
  );
  if ('query' in command.payload) {
    const known = new Set(readTags(db, command.projectId).map((tag) => tag.id));
    requireThat(
      command.payload.query.tagIds.every((id) => known.has(id)),
      'INVALID_SEARCH_TAG',
      '搜索条件只能引用当前项目的标签',
      400,
    );
    state.current = {
      ...command.payload.query,
      tagIds: [...new Set(command.payload.query.tagIds)],
    };
    if (
      state.blockedIdentity &&
      searchConditionIdentity(state.current).id !== state.blockedIdentity
    )
      state.blockedIdentity = null;
  }
  if (command.type === 'search.record') {
    const identity = searchConditionIdentity(state.current);
    if (
      identity.nonempty &&
      (command.payload.intent === 'open' || identity.id !== state.blockedIdentity)
    ) {
      state.blockedIdentity = null;
      state.history = [
        {
          id: identity.id,
          query: structuredClone(state.current),
          usedAt: new Date().toISOString(),
        },
        ...state.history.filter((h) => h.id !== identity.id),
      ].slice(0, 20);
    }
  }
  if (command.type === 'search.clear') {
    state.removed = { id: command.commandId, entries: state.history };
    state.history = [];
    state.blockedIdentity = searchConditionIdentity(state.current).id;
  }
  if (command.type === 'search.delete') {
    const entries = state.history.filter((h) => h.id === command.payload.id);
    requireThat(entries.length, 'NOT_FOUND', '搜索历史已删除，请刷新后重试', 404);
    state.history = state.history.filter((h) => h.id !== command.payload.id);
    state.removed = { id: command.commandId, entries };
    const identity = searchConditionIdentity(state.current).id;
    if (identity === command.payload.id) state.blockedIdentity = identity;
  }
  if (command.type === 'search.restore') {
    requireThat(
      state.removed?.id === command.payload.undoId,
      'SEARCH_UNDO_STALE',
      '这次历史清理已失效',
      409,
    );
    const known = new Set(state.history.map((h) => h.id));
    state.history = [...state.history, ...state.removed.entries.filter((h) => !known.has(h.id))]
      .sort((a, b) => b.usedAt.localeCompare(a.usedAt))
      .slice(0, 20);
    state.removed = null;
    state.blockedIdentity = null;
  }
  state.versionId = randomUUID();
  db.prepare(
    'INSERT INTO mapping_search_state VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET value=excluded.value',
  ).run(command.projectId, JSON.stringify(state));
  return state;
}
