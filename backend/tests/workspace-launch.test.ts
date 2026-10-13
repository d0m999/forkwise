import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('启动命令未显式指定数据目录时直接拒绝，不回退到旧 .data', () => {
  const env = { ...process.env };
  delete env.FORKWISE_DATA_DIR;
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/workspace-server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('请显式设置 FORKWISE_DATA_DIR');
});
