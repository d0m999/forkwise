import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DomainError, requireThat } from '../src/domain/errors.js';
import { openMapping } from '../src/mapping/storage.js';
import type { ContentDelegation } from '../src/services/access.js';

function issueGrant() {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      project: { type: 'string' },
      out: { type: 'string' },
      card: { type: 'string' },
      block: { type: 'string' },
      version: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      hours: { type: 'string', default: '1' },
    },
  });
  const { 'data-dir': dataDir, project, out, card, block, version, start, end, hours } = values;
  const lifetime = Number(hours) * 60 * 60 * 1000;
  requireThat(
    dataDir && project && out && card && block && version &&
      start !== undefined && /^\d+$/.test(start) && end !== undefined && /^\d+$/.test(end) &&
      Number.isFinite(lifetime) && lifetime > 0 &&
      lifetime + Date.now() <= 8.64e15,
    'INVALID_SCOPE', '请提供 --data-dir、--project、--card、--block、--version、--start、--end、--out 和有效的 --hours', 403,
  );
  const scope: ContentDelegation = {
    projectId: project,
    operations: ['body.patch'],
    objectKinds: ['card'],
    cardId: card,
    blockId: block,
    bodyVersionId: version,
    range: { start: Number(start), end: Number(end) },
  };
  const directory = resolve(dataDir);
  const output = resolve(out);
  const outputParent = realpathSync(dirname(output));
  const outputPath = resolve(outputParent, basename(output));
  const workspaceDirectory = statSync(directory);
  const outputDirectory = statSync(outputParent);
  requireThat(
    workspaceDirectory.dev !== outputDirectory.dev || workspaceDirectory.ino !== outputDirectory.ino,
    'INVALID_SCOPE', '请将令牌输出到工作台数据目录之外', 403,
  );
  const localAccess = JSON.parse(readFileSync(resolve(directory, 'local-access.json'), 'utf8')) as { url?: string };
  const humanToken = new URLSearchParams(localAccess.url?.split('#')[1]).get('token') ?? '';
  const mapping = openMapping(directory);
  try {
    const human = mapping.access.authenticate(humanToken);
    mapping.access.human(human);
    mapping.access.project(human, project);
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    const fd = openSync(outputPath, 'wx', 0o600);
    try {
      mapping.access.issue('agent', [project], lifetime, token, [], undefined, [scope]);
      writeFileSync(fd, token + '\n');
    } catch (error) {
      mapping.access.revoke(hash);
      unlinkSync(outputPath);
      throw error;
    } finally {
      closeSync(fd);
    }
    console.log(hash.slice(0, 12));
  } finally {
    mapping.close();
  }
}

try {
  issueGrant();
} catch (error) {
  if (error instanceof DomainError) {
    console.error(`${error.code} ${error.message}`);
    process.exitCode = 2;
  } else if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS_')) {
    console.error('INVALID_SCOPE 参数无效');
    process.exitCode = 2;
  } else {
    console.error('签发正文授权失败');
    process.exitCode = 1;
  }
}
