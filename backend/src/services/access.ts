import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Actor } from '../contracts/entities.js';
import { requireThat } from '../domain/errors.js';

export interface Principal {
  actor: Actor;
  projects: string[];
  tokenHash: string;
}

export const LAYOUT_OPERATIONS = ['pose.move', 'pose.batch'] as const;
export type LayoutOperation = (typeof LAYOUT_OPERATIONS)[number];
// Only cards carry a writable pose today; any other kind would mint a grant
// that every layout check rejects, so the type does not offer one.
export type LayoutObjectKind = 'card';
export const LAYOUT_FIELDS = ['x', 'y', 'width', 'height'] as const;
export type LayoutField = (typeof LAYOUT_FIELDS)[number];
// A layout delegation narrows what an Agent session may move. It never widens
// project access and never grants content, appearance, tags or project edits.
export interface LayoutDelegation {
  projectId: string;
  operations: LayoutOperation[];
  objectKinds: LayoutObjectKind[];
  objectIds: '*' | string[];
  fields: LayoutField[];
}
export interface SessionCapabilities {
  personalRecordProjects?: string[];
  layoutDelegations?: LayoutDelegation[];
}
export class AccessService {
  constructor(
    readonly db: Database.Database,
    readonly clock: () => number = Date.now,
    private secret: Buffer = randomBytes(32),
  ) {}
  issue(
    type: 'human' | 'agent',
    projects: string[],
    lifetimeMs = 8 * 60 * 60 * 1000,
    token = randomBytes(32).toString('base64url'),
    personalRecordProjects: string[] = [],
    layoutDelegations?: LayoutDelegation[],
  ): string {
    const hash = this.hash(token);
    requireThat(
      personalRecordProjects.every((id) => projects.includes(id)),
      'INVALID_SCOPE',
      '委托必须属于授权项目',
      403,
    );
    if (layoutDelegations !== undefined) {
      requireThat(
        Array.isArray(layoutDelegations) &&
          layoutDelegations.every(
            (scope) =>
              scope &&
              projects.includes(scope.projectId) &&
              Array.isArray(scope.operations) &&
              Array.isArray(scope.objectKinds) &&
              Array.isArray(scope.fields) &&
              (scope.objectIds === '*' ||
                (Array.isArray(scope.objectIds) &&
                  scope.objectIds.every((id) => typeof id === 'string'))),
          ),
        'INVALID_SCOPE',
        '布局授权必须属于授权项目并列出操作、对象与字段',
        403,
      );
    }
    requireThat(
      type === 'human' || !projects.includes('*'),
      'INVALID_SCOPE',
      'Agent 需逐项目授权',
      403,
    );
    this.db
      .prepare(
        'INSERT INTO sessions(token_hash,actor_id,type,projects,expires_at,capabilities) VALUES(?,?,?,?,?,?)',
      )
      .run(
        hash,
        type === 'human' ? 'local-owner' : `agent_${randomUUID()}`,
        type,
        JSON.stringify(projects),
        new Date(this.clock() + lifetimeMs).toISOString(),
        JSON.stringify({
          personalRecordProjects,
          ...(layoutDelegations === undefined ? {} : { layoutDelegations }),
        }),
      );
    return token;
  }
  authenticate(token: string): Principal {
    const hash = this.hash(token);
    const row = this.db
      .prepare('SELECT actor_id,type,projects,expires_at FROM sessions WHERE token_hash=?')
      .get(hash) as
      | { actor_id: string; type: 'human' | 'agent'; projects: string; expires_at: string }
      | undefined;
    requireThat(
      row && Date.parse(row.expires_at) > this.clock(),
      'UNAUTHORIZED',
      '本机会话无效或已过期，请从本机启动入口重新打开',
      401,
    );
    return {
      actor: { id: row.actor_id, type: row.type },
      projects: JSON.parse(row.projects),
      tokenHash: hash,
    };
  }
  // A Principal is only a transport context, never self-authenticating. Recheck
  // persisted grants at the Mapping boundary, including after revocation/restart.
  // The same query returns the capabilities so one execute checks the session
  // row once instead of once per authorization step.
  validate(principal: Principal): SessionCapabilities {
    const row = this.db
      .prepare('SELECT actor_id,type,projects,expires_at,capabilities FROM sessions WHERE token_hash=?')
      .get(principal?.tokenHash ?? '') as
      | { actor_id: string; type: string; projects: string; expires_at: string; capabilities: string }
      | undefined;
    requireThat(
      row && Date.parse(row.expires_at) > this.clock(),
      'UNAUTHORIZED',
      '本机会话无效或已过期',
      401,
    );
    requireThat(
      row.actor_id === principal.actor.id &&
        row.type === principal.actor.type &&
        row.projects === JSON.stringify(principal.projects),
      'UNTRUSTED_PRINCIPAL',
      '调用者身份和范围必须来自可信会话',
      403,
    );
    return JSON.parse(row.capabilities) as SessionCapabilities;
  }
  mappingWrite(principal: Principal, projectId: string, capabilities: SessionCapabilities): void {
    this.project(principal, projectId);
    if (principal.actor.type === 'human') return;
    requireThat(
      principal.actor.type === 'agent' &&
        (capabilities.personalRecordProjects ?? []).includes(projectId),
      'EDIT_DELEGATION_REQUIRED',
      '此操作需要本机会话确认或明确的项目编辑委托',
      403,
    );
  }
  project(principal: Principal, projectId: string): void {
    requireThat(
      principal.projects.includes(projectId) ||
        (principal.actor.type === 'human' && principal.projects.includes('*')),
      'PROJECT_FORBIDDEN',
      '没有此项目的访问授权',
      403,
    );
  }
  human(principal: Principal): void {
    requireThat(principal.actor.type === 'human', 'HUMAN_REQUIRED', '此操作需要本机会话确认', 403);
  }
  revoke(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash);
  }
  grants() {
    const rows = this.db
      .prepare(
        "SELECT actor_id AS id,projects,expires_at AS expiresAt,capabilities FROM sessions WHERE type='agent' ORDER BY expires_at DESC",
      )
      .all() as { id: string; projects: string; expiresAt: string; capabilities: string }[];
    return rows.map((row) => ({
      ...row,
      projects: JSON.parse(row.projects) as string[],
      personalRecordProjects: JSON.parse(row.capabilities).personalRecordProjects ?? [],
      expired: Date.parse(row.expiresAt) <= this.clock(),
    }));
  }
  revokeGrant(id: string) {
    this.db.prepare("DELETE FROM sessions WHERE type='agent' AND actor_id=?").run(id);
    return { id, revoked: true };
  }
  grantToken(actorId: string, key: string): string {
    return createHmac('sha256', this.secret)
      .update(JSON.stringify(['agent-grant', actorId, key]))
      .digest('base64url');
  }
  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
