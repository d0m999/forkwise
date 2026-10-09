import { readJournal, historyStatus } from '../repositories/action-history.js';
import type { ResearchRepository } from '../repositories/research.js';
import { readLayout } from '../repositories/layout.js';
import type { ChangeSet } from '../contracts/entities.js';

export function readWorkspace(repo: ResearchRepository, projectId: string) {
  return repo.db
    .transaction(() => ({
      state: repo.snapshot(projectId),
      layout: readLayout(repo, projectId),
      history: historyStatus(readJournal(repo, projectId)),
    }))
    .deferred();
}

/** Receipts are a bounded catch-up cache. Missing receipts always require a
 * full snapshot; they are never reconstructed by guessing intermediate state. */
export function syncProject(
  repo: ResearchRepository,
  projectId: string,
  afterRevision: number,
  layoutVersion: number,
) {
  return repo.db
    .transaction(() => {
      const project = repo.project(projectId);
      const history = historyStatus(readJournal(repo, projectId));
      const revision =
        (
          repo.db.prepare('SELECT version FROM layouts WHERE project_id=?').get(projectId) as
            | { version: number }
            | undefined
        )?.version ?? 0;
      const layout = revision !== layoutVersion ? readLayout(repo, projectId) : null;
      if (project.revision === afterRevision)
        return {
          history,
          projectId,
          revision: project.revision,
          changes: [],
          needsSnapshot: false,
          layout,
        };
      if (afterRevision > project.revision)
        return {
          history,
          projectId,
          revision: project.revision,
          changes: [],
          needsSnapshot: true,
          layout,
        };
      const rows = repo.db
        .prepare(
          "SELECT response FROM operations WHERE project_id=? AND json_type(response,'$.upserted')='array' AND json_extract(response,'$.revisionAfter')>json_extract(response,'$.revisionBefore') AND json_extract(response,'$.revisionAfter')>? AND json_extract(response,'$.revisionAfter')<=? ORDER BY json_extract(response,'$.revisionAfter') LIMIT 101",
        )
        .all(projectId, afterRevision, project.revision) as { response: string }[];
      let next = afterRevision;
      const changes: ChangeSet[] = [];
      for (const row of rows) {
        const change = JSON.parse(row.response) as ChangeSet;
        if (change.revisionAfter <= next) continue;
        if (
          change.projectId !== projectId ||
          change.revisionBefore !== next ||
          change.revisionAfter !== next + 1
        )
          break;
        changes.push(change);
        next = change.revisionAfter;
      }
      const complete = next === project.revision && changes.length <= 100;
      return {
        history,
        projectId,
        revision: project.revision,
        changes: complete ? changes : [],
        needsSnapshot: !complete,
        layout,
      };
    })
    .deferred();
}
