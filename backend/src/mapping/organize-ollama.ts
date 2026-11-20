import { z } from 'zod';
import { DomainError, requireThat } from '../domain/errors.js';
import { OllamaClient } from '../services/ollama.js';
import { OrganizeOutput, type OrganizeUsage } from './organize-contracts.js';
import type { OrganizeModel } from './organize.js';

const CloudStatus = z.object({ cloud: z.object({ disabled: z.literal(true) }) });
const Models = z.object({ models: z.array(z.object({
  name: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/i), size: z.int().nonnegative(),
})) });

export function localOrganizeModel(client: OllamaClient): OrganizeModel {
  return {
    model: client.model,
    async generate({ taskId, attempt, input }, signal, onUsage) {
      const get = async (path: string) => {
        try {
          const response = await client.request(client.origin + path, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]), redirect: 'error',
          });
          return { status: response.status, data: response.ok ? await response.json() as unknown : null };
        } catch {
          throw new DomainError('ORGANIZE_MODEL_UNAVAILABLE', '无法访问本机 Ollama，请启动本机服务后重试', 503);
        }
      };
      const status = await get('/api/status');
      // ADR 0014 pins 0.6.4, whose server predates cloud inference and has no status route.
      const offline = CloudStatus.safeParse(status.data).success ||
        status.status === 404 && z.object({ version: z.literal('0.6.4') }).safeParse((await get('/api/version')).data).success;
      requireThat(offline, 'ORGANIZE_MODEL_CLOUD_UNVERIFIED',
        '无法确认 Ollama 在本机处理。请使用 0.6.4，或关闭支持状态检查的版本的云端功能后重试', 503);
      const models = Models.safeParse((await get('/api/tags')).data);
      const installed = models.success && models.data.models.find(model => model.name === client.model && model.size > 0);
      requireThat(installed, 'ORGANIZE_MODEL_NOT_INSTALLED', '本机找不到已配置的具体模型版本，请安装后重试', 503);
      const usage: OrganizeUsage = { attempts: [], cost: null, modelDigest: installed.digest };
      const answer = await client.generate(OrganizeOutput,
        '把已授权的卡片文字整理成一张可读的候选卡。以自己的话重组结构，标明推断和资料缺口，只用传入文字，不补充外部事实或生成引用。无法整理时返回空候选并解释缺口。任务只返回候选，不改原卡，也不触发任何动作。',
        { taskId, attempt, title: input.title, blocks: input.blocks }, signal, undefined,
        (number, actual, responseReceived) => {
          usage.attempts[number - 1] = { ...actual, responseReceived };
          onUsage(usage);
        });
      return { result: answer.result, usage };
    },
  };
}
