import type { ResearchRepository } from '../repositories/research.js';
import { UpdatePage, UpdateEvents, UpdateTasks } from '../contracts/manual-updates.js';
import { requireThat } from '../domain/errors.js';
function paging(projectId: string, scope: string, raw: unknown) {
  const page = UpdatePage.parse(raw);
  let cursor: any;
  if (page.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(page.cursor, 'base64url').toString());
    } catch {
      /* checked below */
    }
    requireThat(
      Array.isArray(cursor) &&
        cursor.length === 4 &&
        cursor[0] === projectId &&
        cursor[1] === scope &&
        typeof cursor[2] === 'string' &&
        typeof cursor[3] === 'string',
      'INVALID_CURSOR',
      '更新列表游标与读取范围不匹配',
      400,
    );
  }
  return {
    ...page,
    after: cursor ? cursor.slice(2) : null,
    encode: (time: string, id: string) =>
      Buffer.from(JSON.stringify([projectId, scope, time, id])).toString('base64url'),
  };
}
export function readUpdateEvents(repo: ResearchRepository, projectId: string, raw: unknown) {
  const page = paging(projectId, 'events', raw);
  return repo.db
    .transaction(() => {
      repo.project(projectId);
      const rows = repo.db
        .prepare(
          `WITH events AS (
      SELECT json_extract(input,'$.update.eventKey') AS eventKey,json_extract(input,'$.update.sourceId') AS sourceId,json_extract(input,'$.update.materialHash') AS materialHash,
      MIN(created_at) AS firstAt,MAX(created_at) AS latestAt,COUNT(*) AS taskCount,
      SUM(CASE WHEN state='succeeded' THEN COALESCE(json_array_length(output,'$.result.proposals'),0) ELSE 0 END) AS proposalCount,
      SUM(state IN ('queued','running')) AS activeCount,SUM(state IN ('failed','interrupted','partial')) AS blockedCount
      FROM jobs WHERE project_id=? AND kind='research.impact' AND json_extract(input,'$.update.schemaVersion')=1 GROUP BY eventKey,sourceId,materialHash
    ) SELECT events.*,COALESCE(json_extract(e.data,'$.title'),'原来源已移除') AS sourceTitle FROM events LEFT JOIN entities e ON e.project_id=? AND e.id=events.sourceId
      ${page.after ? 'WHERE (latestAt,eventKey)<(?,?)' : ''} ORDER BY latestAt DESC,eventKey DESC LIMIT ?`,
        )
        .all(projectId, projectId, ...(page.after ?? []), page.limit + 1) as any[];
      const items = rows.slice(0, page.limit),
        last = items.at(-1);
      return UpdateEvents.parse({
        items,
        nextCursor: rows.length > page.limit ? page.encode(last.latestAt, last.eventKey) : null,
      });
    })
    .deferred();
}
export function readUpdateTasks(
  repo: ResearchRepository,
  projectId: string,
  eventKey: string,
  raw: unknown,
) {
  requireThat(/^[a-f0-9]{64}$/.test(eventKey), 'INVALID_EVENT', '更新事件身份无效', 400);
  const page = paging(projectId, eventKey, raw);
  return repo.db
    .transaction(() => {
      repo.project(projectId);
      const rows = repo.db
        .prepare(
          `SELECT id,state,created_at AS createdAt,error,json_extract(input,'$.update.scopeLabel') AS scopeLabel,json_extract(input,'$.update.sourceVersionId') AS sourceVersionId,
      json_extract(input,'$.update.bindings') AS bindings,CASE WHEN state='succeeded' THEN COALESCE(json_array_length(output,'$.result.proposals'),0) ELSE 0 END AS proposalCount
      FROM jobs WHERE project_id=? AND kind='research.impact' AND json_extract(input,'$.update.eventKey')=? ${page.after ? 'AND (created_at,id)<(?,?)' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
        )
        .all(projectId, eventKey, ...(page.after ?? []), page.limit + 1) as any[];
      const items = rows.slice(0, page.limit).map(({ bindings, ...row }) => ({
          ...row,
          targetIds: JSON.parse(bindings).map((b: any) => b.target.id),
        })),
        last = items.at(-1);
      return UpdateTasks.parse({
        items,
        nextCursor: rows.length > page.limit ? page.encode(last.createdAt, last.id) : null,
      });
    })
    .deferred();
}
