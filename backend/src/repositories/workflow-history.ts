import type Database from 'better-sqlite3';
import { requireThat } from '../domain/errors.js';

export interface WorkflowGroup {
  id: string;
  projectId: string;
  rootJobId: string;
  applied: boolean;
  stopped: boolean;
}
export type WorkflowHistoryState = 'applied' | 'undone' | 'stopped';
export function workflowGroup(
  db: Database.Database,
  projectId: string,
  id: string,
): WorkflowGroup | undefined {
  const row = db
    .prepare(
      'SELECT id,project_id AS projectId,root_job_id AS rootJobId,applied,stopped FROM workflow_groups WHERE project_id=? AND id=?',
    )
    .get(projectId, id) as
    | (Omit<WorkflowGroup, 'applied' | 'stopped'> & { applied: number; stopped: number })
    | undefined;
  return row ? { ...row, applied: !!row.applied, stopped: !!row.stopped } : undefined;
}
export function taskWorkflow(
  db: Database.Database,
  projectId: string,
  jobId: string,
): WorkflowGroup | undefined {
  const row = db
    .prepare('SELECT group_id FROM workflow_group_tasks WHERE project_id=? AND job_id=?')
    .get(projectId, jobId) as { group_id: string } | undefined;
  return row ? workflowGroup(db, projectId, row.group_id) : undefined;
}
export function workflowHistoryState(
  group: WorkflowGroup | undefined,
): WorkflowHistoryState | undefined {
  return group ? (!group.applied ? 'undone' : group.stopped ? 'stopped' : 'applied') : undefined;
}
export function assertWorkflowWritable(db: Database.Database, projectId: string, id: string) {
  const group = workflowGroup(db, projectId, id);
  requireThat(
    group && group.applied && !group.stopped,
    'WORKFLOW_WITHDRAWN',
    '此研究已被撤销或停止，不应用晚到结果；重做只恢复已完成结果',
    409,
  );
  return group;
}
export function linkWorkflowTask(
  db: Database.Database,
  projectId: string,
  groupId: string,
  jobId: string,
) {
  assertWorkflowWritable(db, projectId, groupId);
  requireThat(
    db.prepare('SELECT id FROM jobs WHERE project_id=? AND id=?').get(projectId, jobId),
    'INVALID_WORKFLOW_TASK',
    '研究阶段任务不属于此项目',
  );
  const old = taskWorkflow(db, projectId, jobId);
  requireThat(!old || old.id === groupId, 'INVALID_WORKFLOW_TASK', '任务已属于另一研究操作');
  db.prepare(
    'INSERT OR IGNORE INTO workflow_group_tasks(job_id,project_id,group_id) VALUES(?,?,?)',
  ).run(jobId, projectId, groupId);
}
export function createWorkflowGroup(
  db: Database.Database,
  projectId: string,
  id: string,
  rootJobId: string,
  childId: string,
) {
  db.prepare('INSERT INTO workflow_groups(id,project_id,root_job_id) VALUES(?,?,?)').run(
    id,
    projectId,
    rootJobId,
  );
  linkWorkflowTask(db, projectId, id, rootJobId);
  linkWorkflowTask(db, projectId, id, childId);
}
export function workflowTasks(db: Database.Database, projectId: string, id: string): string[] {
  return (
    db
      .prepare(
        'SELECT job_id FROM workflow_group_tasks WHERE project_id=? AND group_id=? ORDER BY job_id',
      )
      .all(projectId, id) as { job_id: string }[]
  ).map((r) => r.job_id);
}
/** Runs in the same transaction as restoring graph objects and the history cursor. */
export function travelWorkflow(
  db: Database.Database,
  projectId: string,
  id: string,
  direction: 'undo' | 'redo',
  now: string,
) {
  requireThat(workflowGroup(db, projectId, id), 'INVALID_ACTION_HISTORY', '研究操作分组缺失');
  db.prepare('UPDATE workflow_groups SET applied=?,stopped=1 WHERE project_id=? AND id=?').run(
    direction === 'redo' ? 1 : 0,
    projectId,
    id,
  );
  if (direction === 'undo')
    db.prepare(
      "UPDATE jobs SET state='cancelled',run_token=NULL,error='研究操作已撤销；任务停止，已完成记录保留',updated_at=? WHERE project_id=? AND id IN (SELECT job_id FROM workflow_group_tasks WHERE project_id=? AND group_id=?) AND state IN ('queued','running','interrupted')",
    ).run(now, projectId, projectId, id);
}
export function exportWorkflowGroups(db: Database.Database, projectId: string) {
  const ids = db
    .prepare('SELECT id FROM workflow_groups WHERE project_id=? ORDER BY id')
    .all(projectId) as { id: string }[];
  return ids.map(({ id }) => {
    const { projectId: _projectId, ...group } = workflowGroup(db, projectId, id)!;
    return { ...group, taskIds: workflowTasks(db, projectId, id) };
  });
}
