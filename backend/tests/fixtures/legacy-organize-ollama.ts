import { z } from 'zod';
import { DomainError, requireThat } from '../../src/domain/errors.js';
import { OllamaClient } from '../../src/services/ollama.js';
import type { OrganizeUsage } from '../../src/mapping/organize-contracts.js';
import { ORGANIZE_PURPOSE, OrganizeCandidateOutput } from '../../src/mapping/organize-model-output.js';
import type { OrganizeModel } from '../../src/mapping/organize.js';

const CloudStatus = z.object({ cloud: z.object({ disabled: z.literal(true) }) });
const Models = z.object({ models: z.array(z.object({
  name: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/i), size: z.int().nonnegative(),
})) });

export function localOrganizeModel(client: OllamaClient): OrganizeModel {
  async function resolveDigest(signal: AbortSignal) {
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
    return installed.digest.toLowerCase();
  }

  return {
    model: client.model,
    resolveDigest,
    async generate({ taskId, attempt, input, modelDigest }, signal, onUsage) {
      const usage: OrganizeUsage = { attempts: [], cost: null, modelDigest };
      const confirmDigest = async () => {
        requireThat(await resolveDigest(signal) === modelDigest, 'ORGANIZE_MODEL_CHANGED',
          '本机模型在整理期间已更新，请用当前配置开始新任务', 409);
      };
      const answer = await client.generate(OrganizeCandidateOutput, ORGANIZE_PURPOSE,
        { taskId, attempt, title: input.title, blocks: input.blocks }, signal, undefined,
        {
          beforeRepair: confirmDigest,
          onAttempt(number, actual, responseReceived) {
            usage.attempts[number - 1] = { ...actual, phase: number === 1 ? 'generate' : 'repair', responseReceived };
            onUsage(usage);
          },
        });
      await confirmDigest();
      return { result: answer.result, usage };
    },
  };
}
