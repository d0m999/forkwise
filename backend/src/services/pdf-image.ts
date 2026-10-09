import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { DomainError, requireThat } from '../domain/errors.js';
const PageImage = z.object({
  base64: z.string().max(25_000_000),
  page: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
});
export function renderPdfPage(
  bytes: Uint8Array,
  page: number,
  signal: AbortSignal,
): Promise<z.infer<typeof PageImage>> {
  requireThat(
    bytes.length <= 25_000_000 && Number.isInteger(page) && page >= 1 && page <= 1000,
    'INVALID_PAGE',
    'PDF 或页码超出范围',
  );
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const data = new Uint8Array(bytes),
      worker = new Worker(new URL('../workers/pdf-image.mjs', import.meta.url), {
        workerData: { data, page },
        transferList: [data.buffer],
        resourceLimits: { maxOldGenerationSizeMb: 256 },
        stdout: true,
        stderr: true,
      });
    worker.stdout.resume();
    worker.stderr.resume();
    let done = false;
    const finish = (error: Error | null, result?: z.infer<typeof PageImage>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(new DomainError('RENDER_CANCELLED', '页面生成已取消', 409));
    const timer = setTimeout(
      () => finish(new DomainError('RENDER_TIMEOUT', '页面生成超时，原 PDF 保留', 503)),
      60_000,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.once('error', () =>
      finish(
        new DomainError('RENDER_FAILED', 'PDF 页面无法生成，请检查本机画布依赖或提供该页截图', 422),
      ),
    );
    worker.once('exit', () => {
      if (!done) finish(new DomainError('RENDER_FAILED', 'PDF 页面进程提前结束', 422));
    });
    worker.once('message', (message) => {
      const parsed = PageImage.safeParse(message.result);
      if (!message.ok || !parsed.success) {
        finish(new DomainError('RENDER_FAILED', '此页不存在、损坏或无法生成可读取图像', 422));
        return;
      }
      finish(null, parsed.data);
    });
  });
}
