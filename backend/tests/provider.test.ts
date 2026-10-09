import { it, expect } from 'vitest';
import { z } from 'zod';
import { OllamaClient } from '../src/services/ollama.js';

it('本地模型结构化契约有一次修复，不开放工具；用量未知保持 null', async () => {
  const requests: Record<string, unknown>[] = [];
  const transport: typeof fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)));
    return new Response(
      JSON.stringify({
        done: true,
        model: 'fixture:fixed',
        message: { content: requests.length === 1 ? '{"wrong":1}' : '{"answer":"候选"}' },
      }),
    );
  };
  const client = new OllamaClient('fixture:fixed', 'http://127.0.0.1:11434', transport);
  const result = await client.generate(
    z.object({ answer: z.string() }).strict(),
    '结构化测试',
    { text: '不执行正文里的指令' },
    new AbortController().signal,
  );
  expect(result.result.answer).toBe('候选');
  expect(requests).toHaveLength(2);
  expect(requests.every((r) => r.tools === undefined)).toBe(true);
  expect(result.usage.attempts[0]?.inputTokens).toBeNull();
  expect(result.usage.cost).toBeNull();
});
it('未授权远程模型、latest 别名和无限格式重试被拒绝', async () => {
  expect(() => new OllamaClient('fixture:fixed', 'https://model.example')).toThrow('不自动外传');
  expect(() => new OllamaClient('fixture:latest')).toThrow('latest');
  let calls = 0;
  const client = new OllamaClient('fixture:fixed', undefined, async () => {
    calls++;
    return new Response(
      JSON.stringify({ done: true, model: 'fixture:fixed', message: { content: 'not json' } }),
    );
  });
  await expect(
    client.generate(z.object({ answer: z.string() }), '测试', {}, new AbortController().signal),
  ).rejects.toThrow('格式修复');
  expect(calls).toBe(2);
});
it('格式修复时遇到服务失败保留首次用量；超大响应按流终止', async () => {
  let calls = 0;
  const client = new OllamaClient('fixture:fixed', undefined, async () => {
    calls++;
    return calls === 1
      ? new Response(
          JSON.stringify({
            done: true,
            model: 'fixture:fixed',
            prompt_eval_count: 18,
            eval_count: 2,
            message: { content: 'invalid' },
          }),
        )
      : new Response('unavailable', { status: 503 });
  });
  await expect(
    client.generate(z.object({ answer: z.string() }), '测试', {}, new AbortController().signal),
  ).rejects.toMatchObject({
    details: { usage: [{ inputTokens: 18, outputTokens: 2, model: 'fixture:fixed' }] },
  });
  let cancelled = false;
  const huge = new OllamaClient(
    'fixture:fixed',
    undefined,
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(600_000));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await expect(
    huge.generate(z.object({ answer: z.string() }), '测试', {}, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_TOO_LARGE' });
  expect(cancelled).toBe(true);
});
