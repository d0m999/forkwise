import { resolve } from 'node:path';
import { previewRestore, activateRestore } from '../src/services/activate-restore.js';

const args = process.argv.slice(2),
  target = args.find((arg) => !arg.startsWith('--'));
if (!target) {
  console.error(
    '用法：npm run restore -- 已校验的恢复副本目录 [--confirm-replace]。默认只预览；确认替换前先停止服务。',
  );
  process.exitCode = 2;
} else
  try {
    const directory = resolve(process.env.FORKWISE_DATA_DIR ?? '.data');
    console.log(
      JSON.stringify(
        args.includes('--confirm-replace')
          ? await activateRestore(directory, target)
          : previewRestore(directory, target),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : '恢复失败');
    process.exitCode = 1;
  }
