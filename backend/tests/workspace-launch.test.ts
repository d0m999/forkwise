import { it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));

it('启动命令未显式指定数据目录时直接拒绝，不回退到旧 .data', () => {
  const env = { ...process.env };
  delete env.FORKWISE_DATA_DIR;
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/workspace-server.ts'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('请显式设置 FORKWISE_DATA_DIR');
});

const qualifiedModel = 'gpt-6-luna';
const standardRetention = '选定文字与回复可能为滥用监测通常保留最多 30 天，例外依适用政策。';
const zdrRetention = '此测试项目已核验启用零数据留存（ZDR）。';
const qualification = {
  projectId: 'proj_synthetic_launch',
  model: { id: qualifiedModel, responsesStructuredOutput: { passed: true, reference: 'synthetic model capability evidence' } },
  retentionPolicy: { reference: 'synthetic retention evidence', disclosure: standardRetention },
  noTraining: { passed: true, reference: 'synthetic no training evidence' },
  dataSharingOff: { passed: true, reference: 'synthetic sharing settings' },
  agreement: { reference: 'synthetic agreement' },
};
const qualificationConfig = (record: object) => ({ FORKWISE_OPENAI_ORGANIZE_QUALIFICATION: JSON.stringify(record) });
const qualifiedConfig = { ...qualificationConfig(qualification), OPENAI_API_KEY: 'sk-synthetic-launch-key' };

it.each([
  { label: '未登记核验', config: { OPENAI_API_KEY: qualifiedConfig.OPENAI_API_KEY }, blockedReason: '尚未登记目标 OpenAI API 项目的核验记录。' },
  { label: '记录格式无效', config: { ...qualifiedConfig, FORKWISE_OPENAI_ORGANIZE_QUALIFICATION: '{' }, blockedReason: 'OpenAI API 项目资格记录的 JSON 格式无效。' },
  { label: '模型缺结构化输出核验', config: { ...qualifiedConfig, ...qualificationConfig({ ...qualification, model: { id: qualifiedModel } }) }, blockedReason: 'OpenAI API 项目资格记录中的模型 ID 或 Responses API 结构化输出核验依据缺失或无效。' },
  { label: '缺少留存政策告知', config: { ...qualifiedConfig, ...qualificationConfig({ ...qualification, retentionPolicy: { ...qualification.retentionPolicy, disclosure: ' ' } }) }, blockedReason: 'OpenAI API 项目资格记录中的留存政策核验依据或发送前告知缺失或无效。' },
  { label: '旧 ZDR 字段不足以登记留存政策', config: { ...qualifiedConfig, ...qualificationConfig({ ...qualification, retentionPolicy: undefined, zeroDataRetention: { passed: true, reference: 'synthetic ZDR evidence' } }) }, blockedReason: 'OpenAI API 项目资格记录中的留存政策核验依据或发送前告知缺失或无效。' },
  { label: '尚未关闭数据共享', config: { ...qualifiedConfig, ...qualificationConfig({ ...qualification, dataSharingOff: { ...qualification.dataSharingOff, passed: false } }) }, blockedReason: 'OpenAI API 项目资格记录中的关闭数据共享的核验依据缺失或无效。' },
  { label: '适用协议缺引用', config: { ...qualifiedConfig, ...qualificationConfig({ ...qualification, agreement: {} }) }, blockedReason: 'OpenAI API 项目资格记录中的适用协议引用缺失或无效。' },
  { label: '其他模型家族', config: { ...qualifiedConfig, ...qualificationConfig({ ...qualification, model: { ...qualification.model, id: 'gpt-6-other-2026-01-01' } }) }, blockedReason: '请配置目标项目已核验的 gpt-6-luna。' },
  { label: '请求使用 Luna 日期快照', config: { ...qualifiedConfig, ...qualificationConfig({ ...qualification, model: { ...qualification.model, id: 'gpt-6-luna-2026-01-01' } }) }, blockedReason: '请配置目标项目已核验的 gpt-6-luna。' },
  { label: '项目无效', config: { ...qualifiedConfig, ...qualificationConfig({ ...qualification, projectId: 'bad-project' }) }, blockedReason: 'OpenAI API 项目标识格式无效。' },
  { label: '缺少凭据', config: qualificationConfig(qualification), blockedReason: '缺少 OpenAI API 凭据。' },
  { label: '凭据格式无效', config: { ...qualifiedConfig, OPENAI_API_KEY: 'invalid secret' }, blockedReason: 'OpenAI API 凭据格式无效。' },
  { label: '上游拒绝凭据', config: qualifiedConfig, blockedReason: null, upstream: 401, error: 'OpenAI 拒绝了 API 凭据，请检查凭据是否有效。' },
  { label: '上游拒绝访问', config: qualifiedConfig, blockedReason: null, upstream: 403, error: 'OpenAI 拒绝访问，请检查凭据的项目、模型和 Responses API 权限。' },
  { label: '标准留存项目省略协议生效日也可生成候选', config: qualifiedConfig, blockedReason: null, upstream: 200 },
  { label: '已启用 ZDR 的项目同样可用', config: { ...qualifiedConfig, ...qualificationConfig({ ...qualification,
    retentionPolicy: { ...qualification.retentionPolicy, disclosure: zdrRetention },
    agreement: { ...qualification.agreement, effectiveDate: '2026-01-01' } }) },
    blockedReason: null, upstream: 200, expectedRetention: zdrRetention },
])('正式启动的整理状态与回执：$label', async ({ config, blockedReason, upstream, error, expectedRetention = standardRetention }) => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-organize-launch-'));
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const transport = `
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      const headers = new Headers(options?.headers);
      const body = JSON.parse(options.body);
      if (${upstream ?? 'null'} === null || String(url) !== 'https://api.openai.com/v1/responses' ||
          headers.get('openai-project') !== 'proj_synthetic_launch' ||
          headers.get('authorization') !== 'Bearer sk-synthetic-launch-key' ||
          body.model !== '${qualifiedModel}' || body.store !== false || (body.tools?.length ?? 0) !== 0 ||
          body.text?.format?.strict !== true ||
          body.input?.[1]?.content?.[0]?.text !== JSON.stringify({ title: '合成样例', blocks: ['仅发送这段'] }))
        throw new Error('测试传输收到与夹具不符的请求');
      const payload = ${upstream ?? 'null'} === 200 ? {
        id: 'resp_launch', model: '${qualifiedModel}-2026-01-01', created_at: 1, status: 'completed',
        output: [{ type: 'message', id: 'msg_launch', role: 'assistant', status: 'completed',
          content: [{type: 'output_text', annotations: [],
            text: JSON.stringify({ candidate: { title: '整理候选', text: '仅发送这段' }, gaps: [] }) }] }],
        usage: { input_tokens: 42, output_tokens: 17 },
      } : { error: { message: 'synthetic upstream private error' } };
      return Response.json(payload, {
        status: ${upstream ?? 'null'}, headers: { 'x-request-id': 'req_launch_' + ++calls },
      });
    };
  `;
  const child = spawn(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(transport)}`, 'dist/src/workspace-server.js',
  ], {
    cwd,
    env: {
      ...process.env, NODE_OPTIONS: undefined, OPENAI_API_KEY: undefined,
      FORKWISE_OPENAI_ORGANIZE_QUALIFICATION: undefined,
      ...config, FORKWISE_DATA_DIR: directory, FORKWISE_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit').catch(() => undefined);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2048); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`工作台启动超时 (${child.exitCode}/${child.signalCode}) ${stderr}`)), 4000);
      child.once('error', cause => { clearTimeout(timer); reject(cause); });
      child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`工作台提前退出 (${code}/${signal}) ${stderr}`)); });
      child.stdout.on('data', chunk => {
        if (!String(chunk).includes('见岔开放工作台')) return;
        clearTimeout(timer);
        resolve();
      });
    });
    const { url } = JSON.parse(readFileSync(join(directory, 'local-access.json'), 'utf8'));
    const token = new URLSearchParams(new URL(url).hash.slice(1)).get('token');
    const request = (path: string, body?: object) => fetch(origin + '/api/mapping' + path, {
      method: body ? 'POST' : 'GET',
      headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const execute = (command: object) => request('/execute', { projectId: 'launch-project', expected: null, ...command });
    expect((await execute({ commandId: 'create-project', type: 'project.create', payload: { name: '隔离启动' } })).status).toBe(200);
    const projectPath = '/projects/launch-project';
    const status = await request(projectPath + '/organize/status');
    expect(status.status).toBe(200);
    const statusView = await status.json();
    expect(statusView).toEqual(blockedReason ? { model: null, blockedReason } : {
      model: `openai/${qualifiedModel}`, blockedReason: null,
      sendDisclosure: { id: expect.stringMatching(/^[a-f0-9]{64}$/), retention: expectedRetention },
    });

    expect((await execute({ commandId: 'create-card', type: 'thought.create',
      payload: { id: 'launch-card', title: '合成样例', text: '', x: 10, y: 20 } })).status).toBe(200);
    const { cards: [draft] } = await (await request(projectPath)).json();
    expect((await execute({ commandId: 'write-card', type: 'body.edit', expected: draft.body.versionId,
      payload: { id: draft.id, blocks: [
        { type: 'text', id: 'selected', text: '仅发送这段' },
        { type: 'text', id: 'omitted', text: '私有备注留在本机' },
      ] } })).status).toBe(200);
    const { cards: [card] } = await (await request(projectPath)).json();
    const taskPath = projectPath + '/organize/tasks';
    const input = { cardId: card.id, thoughtVersionId: card.versionId, bodyVersionId: card.body.versionId,
      includeTitle: true, blockIds: ['selected'] };
    const started = await request(taskPath, { ...input, requestId: 'real-launch-task', mode: 'real',
      disclosureId: statusView.sendDisclosure?.id });
    if (blockedReason) {
      expect(started.status).toBe(503);
      expect(await started.json()).toMatchObject({ code: 'ORGANIZE_MODEL_UNCONFIGURED', message: blockedReason });
      const simulation = await request(taskPath, { ...input, requestId: 'simulated-launch-task', mode: 'simulate' });
      expect(simulation.status).toBe(201);
      const { id } = await simulation.json();
      await expect.poll(async () => (await (await request(`${taskPath}/${id}`)).json())).toMatchObject({
        mode: 'simulate', state: 'succeeded', output: { candidate: { title: '模拟整理：合成样例' } },
      });
    } else if (upstream === 200) {
      expect(started.status).toBe(201);
      const { id } = await started.json();
      await expect.poll(async () => (await (await request(`${taskPath}/${id}`)).json())).toMatchObject({
        state: 'succeeded', addAvailable: true, output: { candidate: { title: '整理候选', text: '仅发送这段' } },
        usage: { attempts: [{ requestedModel: qualifiedModel, returnedModel: qualifiedModel + '-2026-01-01',
          providerRequestId: 'req_launch_1', inputTokens: 42, outputTokens: 17 }] },
      });
      expect((await (await request(projectPath)).json()).cards).toEqual([card]);
      expect((await execute({ commandId: 'add-candidate', type: 'organize.add',
        payload: { taskId: id, attempt: 1, x: 300, y: 20 } })).status).toBe(200);
      expect((await (await request(projectPath)).json()).cards).toEqual([card,
        expect.objectContaining({ title: '整理候选', aiOrigin: { mode: 'real', taskId: id } })]);
    } else {
      expect(started.status).toBe(201);
      const { id } = await started.json();
      await expect.poll(async () => (await (await request(`${taskPath}/${id}`)).json()).state).toBe('failed');
      const task = await (await request(`${taskPath}/${id}`)).json();
      expect(task).toMatchObject({ error, output: null, addAvailable: false, usage: { cost: null } });
      expect(task.usage.attempts).toEqual([{
        phase: 'generate', model: `openai/${qualifiedModel}`, requestedModel: qualifiedModel, returnedModel: null, responseReceived: true, providerRequestId: 'req_launch_1',
        inputTokens: null, cachedInputTokens: null, outputTokens: null,
      }]);
      expect(JSON.stringify(task)).not.toContain('synthetic upstream private error');
      expect(await (await request(projectPath + '/organize/status')).json())
        .toEqual(statusView);
      const retry = await request(`${taskPath}/${id}/retry`, { attempt: 1, requestId: 'manual-retry-after-denial',
        disclosureId: statusView.sendDisclosure.id });
      expect(retry.status).toBe(200);
      await expect.poll(async () => (await (await request(`${taskPath}/${id}`)).json())).toMatchObject({
        state: 'failed', attempt: 2, error, usage: { attempts: [{ providerRequestId: 'req_launch_2' }] },
      });
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
  expect([child.exitCode, child.signalCode]).toEqual([0, null]);
}, 10000);

it('作为受控宿主导入时只公开启动函数，不主动运行 CLI 预检', () => {
  const env = { ...process.env };
  delete env.FORKWISE_DATA_DIR;
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval',
    'const { startWorkspace } = await import("./src/workspace-server.ts"); if (typeof startWorkspace !== "function") process.exit(2)',
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
});
