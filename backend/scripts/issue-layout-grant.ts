import { openSync, readFileSync, writeSync, closeSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';
import {
  LAYOUT_FIELDS,
  LAYOUT_OPERATIONS,
  type LayoutDelegation,
} from '../src/services/access.js';

// Local owner entry for issuing a narrow layout delegation to an Agent session.
// The human token comes from the workspace's own local-access.json, so this CLI
// cannot mint authority the local owner does not already hold.
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith('--') || value === undefined) {
    console.error('用法：tsx scripts/issue-layout-grant.ts --data-dir <目录> --project <项目> --out <文件> [--operations pose.move,pose.batch] [--fields x,y,width,height] [--objects *] [--hours 1]');
    process.exit(2);
  }
  args.set(key.slice(2), value);
}
const dataDir = args.get('data-dir');
const projectId = args.get('project');
const out = args.get('out');
if (!dataDir || !projectId || !out) {
  console.error('缺少 --data-dir、--project 或 --out');
  process.exit(2);
}

// Values become part of a signed grant, so reject anything the runtime would
// later deny instead of issuing a token that cannot write.
function parseChoice<T extends string>(flag: string, raw: string, allowed: readonly T[]): T[] {
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  const invalid = values.filter((value) => !allowed.includes(value as T));
  if (!values.length || invalid.length) {
    console.error(
      `${flag} 只接受 ${allowed.join(',')}${invalid.length ? `；非法值：${invalid.join(',')}` : '；至少一项'}`,
    );
    process.exit(2);
  }
  return values as T[];
}

const operations = parseChoice('--operations', args.get('operations') ?? 'pose.move', LAYOUT_OPERATIONS);
const fields = parseChoice('--fields', args.get('fields') ?? 'x,y', LAYOUT_FIELDS);
const objects = args.get('objects') ?? '*';
const objectIds: '*' | string[] =
  objects === '*'
    ? '*'
    : objects.split(',').map((value) => value.trim()).filter(Boolean);
if (objectIds !== '*' && !objectIds.length) {
  console.error('--objects 需要 * 或至少一个卡片 id');
  process.exit(2);
}
const hours = Number(args.get('hours') ?? '1');
if (!Number.isFinite(hours) || hours <= 0) {
  console.error('--hours 必须为正数');
  process.exit(2);
}

const accessFile = resolve(dataDir, 'local-access.json');
let humanToken: string;
try {
  const recorded = JSON.parse(readFileSync(accessFile, 'utf8')) as { url?: string };
  const match = /#token=([^&]+)/.exec(recorded.url ?? '');
  if (!match) throw new Error('local-access.json 不含 token');
  humanToken = decodeURIComponent(match[1]!);
} catch (error) {
  console.error(`无法读取本机启动凭证 ${accessFile}：${(error as Error).message}`);
  process.exit(1);
}

const mapping = openMapping(dataDir);
try {
  const human = mapping.access.authenticate(humanToken);
  mapping.access.human(human);
  mapping.access.project(human, projectId);
  const project = mapping.read({ type: 'project', projectId }, human);
  const missing =
    objectIds === '*'
      ? []
      : objectIds.filter((id) => !project.cards.some((card) => card.id === id));
  if (missing.length) {
    console.error(`--objects 包含项目 ${projectId} 里不存在的卡片：${missing.join(', ')}`);
    process.exitCode = 2;
  } else {
    const scope: LayoutDelegation = {
      projectId,
      operations,
      objectKinds: ['card'],
      objectIds,
      fields,
    };
    const token = randomBytes(32).toString('base64url');
    mapping.access.issue('agent', [projectId], hours * 60 * 60 * 1000, token, [projectId], [scope]);

    const fd = openSync(out, 'w', 0o600);
    try {
      writeSync(fd, token + '\n');
    } finally {
      closeSync(fd);
    }
    chmodSync(out, 0o600);
    console.log(
      JSON.stringify({
        issued: true,
        projectId,
        scope,
        tokenFile: out,
        tokenSha256Prefix: createHash('sha256').update(token).digest('hex').slice(0, 12),
        expiresInHours: hours,
      }),
    );
  }
} finally {
  mapping.close();
}
