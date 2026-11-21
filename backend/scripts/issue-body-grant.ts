import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DomainError, requireThat } from '../src/domain/errors.js';
import { openMapping, readWorkspaceAccessFile } from '../src/mapping/storage.js';
import type { ContentDelegation } from '../src/services/access.js';
import { grantOutputPath, issueGrantFile } from './grant-output.js';

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
  const outputPath = grantOutputPath(directory, out);
  const localAccess = JSON.parse(readWorkspaceAccessFile(directory)) as { url?: string };
  const humanToken = new URLSearchParams(localAccess.url?.split('#')[1]).get('token') ?? '';
  const mapping = openMapping(directory);
  try {
    const human = mapping.access.authenticate(humanToken);
    mapping.access.human(human);
    mapping.access.project(human, project);
    const hashPrefix = issueGrantFile(outputPath, token => {
      mapping.access.issue('agent', [project], lifetime, token, [], undefined, [scope]);
    });
    console.log(hashPrefix);
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
