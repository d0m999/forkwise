import { canonical } from '../domain/canonical.js';
import type Database from 'better-sqlite3';
import type { Block, Card, Command } from './contracts.js';
import { imageTask } from './media-blocks.js';
import { requireThat } from '../domain/errors.js';
import { readAsset } from './media.js';
export function initializeMediaTasks(db: Database.Database) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS mapping_media_tickets(project_id TEXT NOT NULL, ticket TEXT NOT NULL, card_id TEXT NOT NULL, block_id TEXT NOT NULL, state TEXT NOT NULL, request TEXT NOT NULL, PRIMARY KEY(project_id,ticket))',
  );
}
// A retired ticket is never made live by history travel, deletion restoration or
// a new command. Retrying is an explicit new request on the same block.
export function reconcileMediaTasks(
  db: Database.Database,
  projectId: string,
  before: Card | null,
  after: Card | null,
) {
  const next = new Map(
    (after?.body.blocks ?? []).flatMap((b) => {
      const t = imageTask(b);
      return t ? [[String(t.ticket), b.id] as const] : [];
    }),
  );
  for (const b of before?.body.blocks ?? []) {
    const t = imageTask(b);
    if (t && !next.has(String(t.ticket)))
      db.prepare(
        "UPDATE mapping_media_tickets SET state='retired' WHERE project_id=? AND ticket=? AND state='active'",
      ).run(projectId, t.ticket as string);
  }
  for (const b of after?.body.blocks ?? []) {
    const t = imageTask(b);
    if (!t) continue;
    const row = db
      .prepare(
        'SELECT card_id,block_id,state,request FROM mapping_media_tickets WHERE project_id=? AND ticket=?',
      )
      .get(projectId, t.ticket as string) as
      | { card_id: string; block_id: string; state: string; request: string }
      | undefined;
    requireThat(
      !row || (row.card_id === after!.id && row.block_id === b.id),
      'MEDIA_TICKET_CONFLICT',
      '媒体请求已绑定其他目标',
      409,
    );
    const { status, reason, ...request } = t;
    requireThat(
      !row || row.request === canonical(request),
      'MEDIA_TICKET_CONFLICT',
      '媒体ticket已固定原始请求，修改须使用新ticket',
      409,
    );
    if (!row)
      db.prepare('INSERT INTO mapping_media_tickets VALUES(?,?,?,?,?,?)').run(
        projectId,
        t.ticket as string,
        after!.id,
        b.id,
        t.status === 'queued' ? 'active' : 'failed',
        canonical(request),
      );
    else if (row.state !== 'active' && t.status === 'queued') {
      const failed = { ...t, status: 'failed', reason: '原请求已停止，请明确重试' };
      if (b.type === 'imageTask') Object.assign(b, failed);
      else b.request = failed;
    }
  }
}
export function completeMediaTask(
  db: Database.Database,
  projectId: string,
  card: Card,
  command: Extract<Command, { type: 'media.finish' | 'media.fail' | 'media.retry' }>,
): Block {
  const row = db
    .prepare(
      'SELECT card_id,block_id,state,request FROM mapping_media_tickets WHERE project_id=? AND ticket=?',
    )
    .get(projectId, command.expected) as
    | { card_id: string; block_id: string; state: string; request: string }
    | undefined;
  const block = card.body.blocks.find((b) => b.id === command.payload.blockId),
    task = block && imageTask(block);
  requireThat(
    row &&
      (command.type === 'media.retry' || row.state === 'active') &&
      row.card_id === card.id &&
      row.block_id === block?.id &&
      task?.ticket === command.expected,
    'MEDIA_TASK_STALE',
    '原媒体请求已失效，晚到结果未写入',
    409,
  );
  let replacement: Block;
  if (command.type === 'media.retry') {
    requireThat(
      !db
        .prepare('SELECT 1 FROM mapping_media_tickets WHERE project_id=? AND ticket=?')
        .get(projectId, command.payload.ticket),
      'MEDIA_TICKET_CONFLICT',
      '重试须使用新的请求ticket',
      409,
    );
    const { reason, ...original } = task;
    const next = { ...original, ticket: command.payload.ticket, status: 'queued' };
    replacement = block.type === 'imageTask' ? next : { ...block, request: next };
  } else if (command.type === 'media.fail') {
    const failed = { ...task, status: 'failed', reason: command.payload.reason };
    replacement = block.type === 'imageTask' ? failed : { ...block, request: failed };
  } else {
    const asset = readAsset(db, projectId, command.payload.assetId);
    requireThat(
      task.name === asset.name && task.mime === asset.mime && task.base64 === asset.base64,
      'MEDIA_TASK_MISMATCH',
      '媒体结果不属于原请求',
      409,
    );
    const { request, ...previous } = block;
    replacement = {
      ...(block.type === 'image'
        ? previous
        : { id: block.id, ...(block.inlineId ? { inlineId: block.inlineId } : {}) }),
      type: 'image',
      assetId: asset.id,
      name: asset.name,
      mime: asset.mime,
      naturalWidth: asset.width,
      naturalHeight: asset.height,
    };
  }
  db.prepare('UPDATE mapping_media_tickets SET state=? WHERE project_id=? AND ticket=?').run(
    command.type === 'media.finish'
      ? 'completed'
      : command.type === 'media.retry'
        ? 'retired'
        : 'failed',
    projectId,
    command.expected,
  );
  return replacement;
}
