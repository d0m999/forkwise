import type { ResearchRepository } from './research.js';
import { LayoutInput, type Layout } from '../contracts/layout.js';
import type { Actor } from '../contracts/entities.js';
import { canonical } from '../domain/canonical.js';
import { requireThat } from '../domain/errors.js';

export function readLayout(repo: ResearchRepository, projectId: string): Layout {
  repo.project(projectId);
  const row = repo.db
    .prepare('SELECT version,data FROM layouts WHERE project_id=?')
    .get(projectId) as { version: number; data: string } | undefined;
  return row
    ? { version: row.version, data: JSON.parse(row.data) }
    : { version: 0, data: { positions: {}, drawings: [] } };
}
/** Runs inside the caller's business transaction, after graph changes. */
export function saveLayout(
  repo: ResearchRepository,
  projectId: string,
  raw: unknown,
  now: string,
  actor?: Actor,
): Layout {
  const input = LayoutInput.parse(raw),
    old = readLayout(repo, projectId);
  requireThat(
    old.version === input.expectedVersion,
    'LAYOUT_CONFLICT',
    '画布布局已变化，请重新读取并保留草稿',
    409,
  );
  if (actor?.type === 'agent')
    requireThat(
      canonical(input.data.canvas?.drafts ?? {}) === canonical(old.data.canvas?.drafts ?? {}),
      'HUMAN_DRAFT_PROTECTED',
      'Agent 不能改写本人的编辑草稿',
      403,
    );
  const objects = repo.snapshot(projectId).objects,
    allowed = new Set(objects.map((e) => e.id));
  requireThat(
    Object.keys(input.data.positions).every((id) => allowed.has(id)),
    'INVALID_LAYOUT_REFERENCE',
    '布局引用了不存在的研究对象',
  );
  requireThat(
    Object.values(input.data.canvas?.attachments ?? {}).every((a) => allowed.has(a.target)),
    'INVALID_LAYOUT_REFERENCE',
    '随动批注引用了不存在的研究对象',
  );
  for (const [id, ports] of Object.entries(input.data.ports ?? {})) {
    const inference = objects.find((e) => e.id === id);
    requireThat(
      inference?.kind === 'inference' &&
        Object.keys(ports.premises).every((p) => inference.data.premiseIds.includes(p)),
      'INVALID_LAYOUT_REFERENCE',
      '连接边不属于当前推导',
    );
  }
  if (JSON.stringify(old.data) === JSON.stringify(input.data)) return old;
  repo.db
    .prepare(
      'INSERT INTO layouts(project_id,version,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET version=excluded.version,data=excluded.data,updated_at=excluded.updated_at',
    )
    .run(projectId, old.version + 1, JSON.stringify(input.data), now);
  return readLayout(repo, projectId);
}

export function pruneLayout(
  repo: ResearchRepository,
  projectId: string,
  now: string,
): Layout | undefined {
  const old = readLayout(repo, projectId),
    objects = repo.snapshot(projectId).objects,
    ids = new Set(objects.map((e) => e.id));
  const data = structuredClone(old.data);
  data.positions = Object.fromEntries(Object.entries(data.positions).filter(([id]) => ids.has(id)));
  if (data.canvas?.attachments)
    data.canvas.attachments = Object.fromEntries(
      Object.entries(data.canvas.attachments).filter(([, a]) => ids.has(a.target)),
    );
  if (data.ports)
    data.ports = Object.fromEntries(
      Object.entries(data.ports).flatMap(([id, ports]) => {
        const e = objects.find((e) => e.id === id);
        return e?.kind === 'inference'
          ? [
              [
                id,
                {
                  ...ports,
                  premises: Object.fromEntries(
                    Object.entries(ports.premises).filter(([p]) => e.data.premiseIds.includes(p)),
                  ),
                },
              ],
            ]
          : [];
      }),
    );
  if (JSON.stringify(data) === JSON.stringify(old.data)) return;
  return saveLayout(repo, projectId, { expectedVersion: old.version, data }, now);
}
