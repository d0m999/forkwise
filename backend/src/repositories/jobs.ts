import {
  taskWorkflow,
  workflowHistoryState,
  type WorkflowHistoryState,
} from './workflow-history.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { requireThat } from '../domain/errors.js';

export type JobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export interface Job {
  id: string;
  projectId: string;
  kind: string;
  state: JobState;
  input: unknown;
  output: unknown;
  error: string | null;
  attempt: number;
  runToken: string | null;
  createdAt: string;
  updatedAt: string;
  usage: unknown;
  historyState?: WorkflowHistoryState;
}
export class JobRepository {
  constructor(
    readonly db: Database.Database,
    readonly clock: () => string = () => new Date().toISOString(),
  ) {}
  enqueue(projectId: string, kind: string, input: unknown, dedupeKey: string): Job {
    const existing = this.db
      .prepare('SELECT id FROM jobs WHERE project_id=? AND dedupe_key=?')
      .get(projectId, dedupeKey) as { id: string } | undefined;
    if (existing) return this.get(projectId, existing.id);
    const id = randomUUID();
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO jobs(id,project_id,kind,state,input,attempt,created_at,updated_at,dedupe_key)
      VALUES(?,?,?,'queued',?,0,?,?,?)`,
      )
      .run(id, projectId, kind, JSON.stringify(input), now, now, dedupeKey);
    return this.get(projectId, id);
  }
  assertCapacity(projectId: string): void {
    const backlog = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE project_id=? AND state IN ('queued','running')",
      )
      .get(projectId) as { count: number };
    requireThat(
      backlog.count < 100,
      'TASK_BACKPRESSURE',
      '当前项目待处理任务过多，请等待或取消部分任务后再提交',
      503,
    );
  }
  get(projectId: string, id: string): Job {
    const row = this.db
      .prepare(
        `SELECT id,project_id AS projectId,kind,state,input,output,error,attempt,run_token AS runToken,
      created_at AS createdAt,updated_at AS updatedAt,usage FROM jobs WHERE project_id=? AND id=?`,
      )
      .get(projectId, id) as
      | (Job & { input: string; output: string | null; usage: string | null })
      | undefined;
    requireThat(row, 'JOB_NOT_FOUND', '任务不存在', 404);
    const historyState = workflowHistoryState(taskWorkflow(this.db, projectId, id));
    return {
      ...row,
      ...(historyState ? { historyState } : {}),
      input: JSON.parse(row.input),
      output: row.output ? JSON.parse(row.output) : null,
      usage: row.usage ? JSON.parse(row.usage) : null,
    };
  }
  summaries(projectId: string) {
    const rows = this.db
      .prepare(
        `SELECT j.id,j.project_id AS projectId,j.kind,j.state,j.error,j.attempt,j.created_at AS createdAt,j.updated_at AS updatedAt,j.usage,
        CASE WHEN j.kind IN ('condition.rule','condition.agent') THEN
          json_object('id',json_extract(j.input,'$.condition.id'),'versionId',json_extract(j.input,'$.condition.contentVersionId'))
        ELSE NULL END AS condition,
        CASE WHEN g.id IS NULL THEN NULL WHEN g.applied=0 THEN 'undone' WHEN g.stopped=1 THEN 'stopped' ELSE 'applied' END AS historyState
        FROM jobs j LEFT JOIN workflow_group_tasks t ON t.project_id=j.project_id AND t.job_id=j.id
        LEFT JOIN workflow_groups g ON g.project_id=t.project_id AND g.id=t.group_id
        WHERE j.project_id=? ORDER BY j.created_at,j.id`,
      )
      .all(projectId) as (Omit<Job, 'input' | 'output' | 'runToken' | 'usage' | 'historyState'> & {
      usage: string | null;
      condition: string | null;
      historyState: WorkflowHistoryState | null;
    })[];
    return rows.map((row) => {
      const { condition, historyState, ...summary } = row;
      return {
        ...summary,
        ...(historyState ? { historyState } : {}),
        usage: row.usage ? JSON.parse(row.usage) : null,
        ...(condition ? { condition: JSON.parse(condition) } : {}),
      };
    });
  }
  list(projectId: string): Job[] {
    return (
      this.db
        .prepare('SELECT id FROM jobs WHERE project_id=? ORDER BY created_at,id')
        .all(projectId) as { id: string }[]
    ).map((r) => this.get(projectId, r.id));
  }
  claim(projectId: string, id: string): Job | null {
    return this.db
      .transaction(() => {
        const group = taskWorkflow(this.db, projectId, id);
        if (group && (!group.applied || group.stopped)) return null;
        const runToken = randomUUID();
        const update = this.db
          .prepare(
            "UPDATE jobs SET state='running',run_token=?,attempt=attempt+1,error=NULL,updated_at=? WHERE project_id=? AND id=? AND state='queued'",
          )
          .run(runToken, this.clock(), projectId, id);
        return update.changes ? this.get(projectId, id) : null;
      })
      .immediate();
  }

  isRunning(job: Job): boolean {
    const current = this.get(job.projectId, job.id);
    return current.state === 'running' && current.runToken === job.runToken;
  }
  checkpoint(job: Job, output: unknown, usage: unknown = null): boolean {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET output=?,usage=?,updated_at=? WHERE project_id=? AND id=? AND state='running' AND run_token=?",
        )
        .run(
          JSON.stringify(output),
          JSON.stringify(usage),
          this.clock(),
          job.projectId,
          job.id,
          job.runToken,
        ).changes > 0
    );
  }
  finish(
    job: Job,
    state: 'succeeded' | 'partial' | 'failed',
    output: unknown,
    error: string | null,
    usage: unknown = null,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE jobs SET state=?,output=?,error=?,usage=?,run_token=NULL,updated_at=?
      WHERE id=? AND project_id=? AND state='running' AND run_token=?`,
        )
        .run(
          state,
          JSON.stringify(output),
          error,
          JSON.stringify(usage),
          this.clock(),
          job.id,
          job.projectId,
          job.runToken,
        ).changes > 0
    );
  }
  recordDiscardedUsage(job: Job, usage: unknown): void {
    this.db
      .prepare(
        "UPDATE jobs SET usage=? WHERE project_id=? AND id=? AND state IN ('cancelled','interrupted') AND attempt=?",
      )
      .run(
        JSON.stringify({ actual: usage, resultDiscarded: true, cost: null }),
        job.projectId,
        job.id,
        job.attempt,
      );
  }
  cancel(projectId: string, id: string): Job {
    this.get(projectId, id);
    this.db
      .prepare(
        "UPDATE jobs SET state='cancelled',run_token=NULL,updated_at=? WHERE project_id=? AND id=? AND state IN ('queued','running','interrupted')",
      )
      .run(this.clock(), projectId, id);
    return this.get(projectId, id);
  }
  retry(projectId: string, id: string): Job {
    return this.db
      .transaction(() => {
        const job = this.get(projectId, id);
        requireThat(
          !job.historyState || job.historyState === 'applied',
          'WORKFLOW_WITHDRAWN',
          '此研究已通过撤销停止，重做只恢复已完成结果；继续查证请发起新的研究任务',
          409,
        );
        requireThat(
          ['failed', 'interrupted', 'partial'].includes(job.state),
          'JOB_NOT_RETRYABLE',
          '只有失败、中断或部分完成的任务可以重试',
          409,
        );
        this.db
          .prepare(
            "UPDATE jobs SET state='queued',error=NULL,run_token=NULL,updated_at=? WHERE project_id=? AND id=? AND state IN ('failed','interrupted','partial')",
          )
          .run(this.clock(), projectId, id);
        return this.get(projectId, id);
      })
      .immediate();
  }

  recover(): number {
    return this.db
      .prepare(
        "UPDATE jobs SET state='interrupted',run_token=NULL,error='运行进程已中断，请检查后重试',updated_at=? WHERE state='running'",
      )
      .run(this.clock()).changes;
  }
}
