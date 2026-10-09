import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { DomainError, requireThat } from '../domain/errors.js';

export const TextRegion = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  page: z.number().int().positive(),
  bbox: z.tuple([
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
  ]),
  coordinateSystem: z.literal('viewport-points'),
  localization: z.literal('text-layer-estimate'),
});
export const ParsedPdf = z.object({
  text: z.string().max(5_000_000),
  normalizerVersion: z.literal('pdf-text@1'),
  pageCount: z.number().int().positive(),
  pages: z.array(
    z.object({
      page: z.number().int().positive(),
      width: z.number().positive(),
      height: z.number().positive(),
      status: z.enum(['text', 'needs_ocr', 'failed']),
      message: z.string(),
    }),
  ),
  regions: z.array(TextRegion),
  status: z.enum(['complete', 'partial']),
  gaps: z.array(z.string()),
});
export type PdfResult = z.infer<typeof ParsedPdf>;
export function parsePdf(
  bytes: Uint8Array,
  signal: AbortSignal,
  pageLimit = 1000,
): Promise<PdfResult> {
  requireThat(
    bytes.byteLength > 0 && bytes.byteLength <= 25_000_000,
    'INVALID_FILE_SIZE',
    'PDF 需要为 1 字节至 25 MB',
  );
  requireThat(
    Number.isInteger(pageLimit) && pageLimit > 0 && pageLimit <= 1000,
    'INVALID_PAGE_LIMIT',
    '页数边界无效',
  );
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const data = new Uint8Array(bytes);
    const worker = new Worker(new URL('../workers/pdf.mjs', import.meta.url), {
      workerData: { data, pageLimit },
      transferList: [data.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      stdout: true,
      stderr: true,
    });
    // Library diagnostics can contain source text; expose structured failure reasons instead.
    worker.stdout.resume();
    worker.stderr.resume();
    let done = false;
    const finish = (error: Error | null, result?: PdfResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () =>
      finish(new DomainError('PARSE_CANCELLED', 'PDF 解析已取消，原文件保持', 409));
    const timer = setTimeout(
      () =>
        finish(
          new DomainError(
            'PARSE_TIMEOUT',
            'PDF 解析超过本次处理时间，原文件保持，可缩小范围后重试',
            503,
          ),
        ),
      60_000,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.once('error', () =>
      finish(new DomainError('PDF_WORKER_FAILED', 'PDF 解析进程失败，未将不完整结果标为成功', 422)),
    );
    worker.once('exit', (code) => {
      if (!done)
        finish(new DomainError('PDF_WORKER_EXITED', `PDF 解析进程提前退出（${code}）`, 422));
    });
    worker.once('message', (message: { ok: boolean; result?: unknown; code?: string }) => {
      if (!message.ok) {
        finish(
          new DomainError(
            message.code === 'PasswordException' ? 'PDF_PASSWORD_REQUIRED' : 'PDF_INVALID',
            message.code === 'PasswordException'
              ? 'PDF 需要密码；请提供有权使用的可读取副本'
              : 'PDF 损坏或无法读取，原文件保持',
            422,
          ),
        );
        return;
      }
      const parsed = ParsedPdf.safeParse(message.result);
      if (!parsed.success) {
        finish(new DomainError('INVALID_PARSE_RESULT', 'PDF 解析产物不符合定位契约', 422));
        return;
      }
      finish(null, parsed.data);
    });
  });
}
