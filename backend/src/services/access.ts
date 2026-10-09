import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Actor } from '../contracts/entities.js';
import { requireThat } from '../domain/errors.js';

export interface Principal {
  actor: Actor;
  projects: string[];
  tokenHash: string;
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
  ): string {
    const hash = this.hash(token);
    requireThat(
      personalRecordProjects.every((id) => projects.includes(id)),
      'INVALID_SCOPE',
      '委托必须属于授权项目',
      403,
    );
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
        JSON.stringify({ personalRecordProjects }),
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
