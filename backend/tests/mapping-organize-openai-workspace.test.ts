import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { openAIOrganizeModel } from '../src/mapping/organize-openai.js';
import { inspectPackage } from '../src/mapping/package-verify.js';
import { openMapping } from '../src/mapping/storage.js';

it('用 OpenAI 协议替身从 Mapping 请求整理，只发送所选正文并在明确添加后持久化', async () => {
  const model = 'gpt-6-luna';
  const modelName = `openai/${model}`;
  const cardId = 'source-card-private-id';
  const projectId = 'project-private-id';
  const title = '未选择的样例标题';
  const selectedId = 'selected-block-private-id';
  const omittedText = '不发送的样例备注';
  const selectedText = '这段样例说明交付周期由四周延长至六周。';
  const candidate = { title: '交付周期延长', text: '样例中的交付周期从四周增加到六周。' };
  const apiKey = 'sk-synthetic-forkwise-test-key';
  const retentionDisclosure = '测试项目适用的留存说明。';
  const vendorProjects: (string | null)[] = [];
  const external = vi.fn<typeof fetch>(async (_url, options) => {
    vendorProjects.push(new Headers(options?.headers).get('openai-project'));
    const serialized = JSON.stringify(JSON.parse(String(options?.body)).input);
    expect(serialized).toContain(selectedText);
    for (const unwanted of [projectId, cardId, selectedId, title, omittedText, 'original-start-request']) {
      expect(serialized).not.toContain(unwanted);
    }
    return Response.json({
      id: 'resp_fixture', model, status: 'completed', created_at: 1, error: null, incomplete_details: null,
      output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', phase: 'final_answer', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify({ candidate, gaps: [] }), annotations: [] }] }],
      usage: { input_tokens: 74, input_tokens_details: { cached_tokens: 32 }, output_tokens: 19, total_tokens: 93 },
    }, { headers: { 'x-request-id': `req_openai_fixture_${vendorProjects.length}` } });
  });
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-openai-workspace-'));
  const origin = 'http://127.0.0.1:8790';
  const projectPath = `/api/mapping/projects/${projectId}`;
  const taskPath = `${projectPath}/organize/tasks`;
  let mapping = openMapping(directory, {
    organizeModel: openAIOrganizeModel({ apiKey, projectId: 'proj_fixture123', retentionDisclosure }, external),
  });
  let app = createWorkspaceApp(mapping, origin, () => new Response(''));
  const token = mapping.access.issue('human', ['*']);
  const request = (path: string, body?: unknown, auth = token) => app.request(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const execute = (command: object) => request('/api/mapping/execute', { projectId, expected: null, ...command });
  try {
    expect((await execute({ commandId: 'create-project', type: 'project.create', payload: { name: '隔离样例' } })).status).toBe(200);
    expect((await execute({ commandId: 'create-card', type: 'thought.create',
      payload: { id: cardId, title, text: '', x: 10, y: 20 } })).status).toBe(200);
    const initial = await (await request(projectPath)).json();
    expect((await execute({ commandId: 'write-body', type: 'body.edit', expected: initial.cards[0].body.versionId,
      payload: { id: cardId, blocks: [
        { type: 'text', id: selectedId, text: selectedText },
        { type: 'text', id: 'omitted-block', text: omittedText },
      ] } })).status).toBe(200);
    const before = await (await request(projectPath)).json();
    const [source] = before.cards;
    const statusPath = projectPath + '/organize/status';
    const { sendDisclosure } = await (await request(statusPath)).json();
    expect(sendDisclosure).toEqual({ id: expect.any(String), retention: retentionDisclosure });
    const start = { disclosureId: sendDisclosure.id, requestId: 'original-start-request', mode: 'real', cardId,
      thoughtVersionId: source.versionId, bodyVersionId: source.body.versionId,
      includeTitle: false, blockIds: [selectedId] };

    const agent = mapping.access.issue('agent', [projectId]);
    expect((await request(taskPath, start, agent)).status).toBe(403);
    const earlyCancellation = await request(`${taskPath}/cancel-start`, { ...start, requestId: 'cancel-before-start' });
    expect(earlyCancellation.status).toBe(200);
    const cancelled = await earlyCancellation.json();
    expect(cancelled).toMatchObject({ mode: 'real', model: modelName, state: 'cancelled', attempt: 1 });
    expect(cancelled).not.toHaveProperty('retryBlockedReason');
    expect(await (await request(`${taskPath}/${cancelled.id}`)).json()).toMatchObject({ retryBlockedReason: null });
    expect(external).toHaveBeenCalledTimes(0);
    const started = await request(taskPath, start);
    expect(started.status).toBe(201);
    const { id } = await started.json();
    const readTask = async () => (await request(`${taskPath}/${id}`)).json();
    await vi.waitFor(async () => expect(await readTask()).toMatchObject({
      mode: 'real', model: modelName, state: 'succeeded', output: { candidate, gaps: [] },
      input: { title: null, omittedBlockCount: 1, blocks: [{ id: selectedId, text: selectedText }] },
      attempts: [{ usage: { cost: null, attempts: [{
        phase: 'generate', inputTokens: 74, cachedInputTokens: 32, outputTokens: 19, responseReceived: true,
        providerRequestId: 'req_openai_fixture_1',
      }] } }],
    }));
    expect(await (await request(projectPath)).json()).toEqual(before);
    expect(await (await request(taskPath, { ...start, disclosureId: undefined })).json())
      .toMatchObject({ id });
    expect(external).toHaveBeenCalledTimes(1);

    const add = { commandId: 'add-candidate', type: 'organize.add', payload: { taskId: id, attempt: 1, x: 220, y: 20 } };
    const added = await execute(add);
    expect(added.status).toBe(200);
    expect(await (await execute(add)).json()).toEqual(await added.json());
    const after = await (await request(projectPath)).json();
    expect(after.cards).toHaveLength(2);
    expect(after.cards.find((card: { id: string }) => card.id === cardId)).toEqual(source);
    expect(after.cards.find((card: { id: string }) => card.id !== cardId))
      .toMatchObject({ title: candidate.title, aiOrigin: { mode: 'real', taskId: id } });
    expect(after.connectors).toEqual(before.connectors);

    mapping.close();
    mapping = openMapping(directory, {
      organizeModel: openAIOrganizeModel({ apiKey, projectId: 'proj_fixture456', retentionDisclosure }, external),
    });
    app = createWorkspaceApp(mapping, origin, () => new Response(''));
    expect(await (await request(taskPath, start)).json()).toMatchObject({ id, applied: true });
    expect(external).toHaveBeenCalledTimes(1);
    const crossProjectTask = await (await request(`${taskPath}/${cancelled.id}`)).json();
    expect(crossProjectTask).toMatchObject({ model: modelName, state: 'cancelled', attempt: 1,
      retryBlockedReason: '整理任务的模型配置不匹配，请用当前配置开始新任务。' });
    expect(crossProjectTask).not.toHaveProperty('configuredModelDigest');
    const crossProjectRetry = await request(`${taskPath}/${cancelled.id}/retry`, {
      requestId: 'retry-after-openai-project-switch', attempt: 1,
    });
    expect(crossProjectRetry.status).toBe(409);
    expect(await crossProjectRetry.json()).toMatchObject({ code: 'ORGANIZE_MODEL_CHANGED', message: crossProjectTask.retryBlockedReason });
    expect(await (await request(`${taskPath}/${cancelled.id}`)).json()).toMatchObject({ state: 'cancelled', attempt: 1 });
    expect(external).toHaveBeenCalledTimes(1);
    const nextStart = { ...start, requestId: 'same-scope-other-openai-project' };
    const staleDisclosure = await request(taskPath, nextStart);
    expect(staleDisclosure.status).toBe(409);
    expect(await staleDisclosure.json()).toMatchObject({ code: 'ORGANIZE_DISCLOSURE_CHANGED' });
    expect(external).toHaveBeenCalledTimes(1);
    const nextStatus = await (await request(statusPath)).json();
    const anotherProject = await request(taskPath, { ...nextStart, disclosureId: nextStatus.sendDisclosure.id });
    expect(anotherProject.status).toBe(201);
    const secondTask = await anotherProject.json();
    expect(secondTask.id).not.toBe(id);
    await vi.waitFor(async () => {
      expect(await (await request(`${taskPath}/${secondTask.id}`)).json()).toMatchObject({
        state: 'succeeded', usage: { attempts: [{ providerRequestId: 'req_openai_fixture_2' }] },
      });
    });
    expect(vendorProjects).toEqual(['proj_fixture123', 'proj_fixture456']);

    mapping.close();
    mapping = openMapping(directory);
    app = createWorkspaceApp(mapping, origin, () => new Response(''));
    expect((await (await request(projectPath)).json()).cards).toEqual(after.cards);
    expect(await (await request(taskPath, start)).json()).toMatchObject({ id, model: modelName, applied: true });
    expect((await request(taskPath, { ...start, requestId: 'new-request-without-a-model' })).status).toBe(503);
    const archive = await request(`${projectPath}/export.package`);
    expect(archive.status).toBe(200);
    const inspected = inspectPackage(Buffer.from(await archive.arrayBuffer()));
    expect(inspected).toMatchObject({
      ok: true, manifest: { extensions: { forkwiseOrganize: [{ projectId, tasks: expect.arrayContaining([
        expect.objectContaining({ id, model: modelName, applied: true,
          usage: expect.objectContaining({ attempts: [expect.objectContaining({ providerRequestId: 'req_openai_fixture_1', cachedInputTokens: 32 })] }) }),
        expect.objectContaining({ id: secondTask.id, model: modelName, applied: false }),
      ]) }] } },
    });
    expect(JSON.stringify(inspected)).not.toContain('retryBlockedReason');
    expect(external).toHaveBeenCalledTimes(2);
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('别名每个新请求取得独立结果，取消后重试仍可重放原请求和恢复各次模型回执', async () => {
  const model = 'gpt-6-luna';
  const snapshots = [model, 'gpt-6-luna-2026-01-01', 'gpt-6-luna-2026-01-02'];
  let call = 0;
  const external = vi.fn<typeof fetch>(async () => {
    const returned = snapshots[call++];
    return Response.json({
      id: 'resp_test', created_at: 1, model: returned, status: 'completed',
      output: [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify({ candidate: { title: '标题', text: returned }, gaps: [] }), annotations: [] }] }],
    });
  });
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-openai-alias-'));
  const adapter = openAIOrganizeModel({ apiKey: 'test-key', projectId: 'proj_fixture', retentionDisclosure: '测试留存说明。' }, external);
  let mapping = openMapping(directory, { organizeModel: adapter });
  const token = mapping.access.issue('human', ['*']);
  let human = mapping.access.authenticate(token);
  try {
    mapping.execute({ projectId: 'p', commandId: 'project', expected: null, type: 'project.create',
      payload: { name: '样例' } }, human);
    mapping.execute({ projectId: 'p', commandId: 'card', expected: null, type: 'thought.create',
      payload: { id: 'c', title: '标题', text: '', x: 0, y: 0 } }, human);
    const [card] = mapping.read({ type: 'project', projectId: 'p' }, human).cards;
    const input = { mode: 'real', cardId: 'c', thoughtVersionId: card!.versionId,
      bodyVersionId: card!.body.versionId, includeTitle: true, blockIds: [] };
    const disclosureId = adapter.sendDisclosure!.id;
    const start = (requestId: string) => mapping.organize.start('p', { ...input, requestId, disclosureId }, human);
    const cancelled = await mapping.organize.cancelStart('p', { ...input, requestId: 'cancelled' }, human);
    const first = await start('first');
    const retry = { attempt: 1, requestId: 'manual-retry' };
    expect(() => mapping.organize.retry('p', cancelled.id, retry, human)).toThrow('确认当前的发送和留存说明');
    mapping.organize.retry('p', cancelled.id, { ...retry, disclosureId }, human);
    const second = await start('second');
    const tasks = [first.task, cancelled, second.task];
    expect(new Set(tasks.map(task => task.id)).size).toBe(3);
    const receipt = (index: number) => ({
      state: 'succeeded', output: { candidate: { text: snapshots[index] } },
      usage: { attempts: [{ requestedModel: model, returnedModel: snapshots[index] }] },
    });
    for (const [index, task] of tasks.entries()) {
      await vi.waitFor(() => expect(mapping.organize.get('p', task.id, human)).toMatchObject(receipt(index)));
    }
    mapping.close();
    mapping = openMapping(directory);
    human = mapping.access.authenticate(token);
    for (const [index, requestId] of ['first', 'cancelled', 'second'].entries()) {
      expect(await start(requestId)).toMatchObject({ created: false, task: { ...receipt(index), id: tasks[index]!.id } });
    }
    expect(mapping.organize.retry('p', cancelled.id, retry, human)).toMatchObject({ ...receipt(1), attempt: 2 });
    const app = createWorkspaceApp(mapping, 'http://127.0.0.1:8790', () => new Response(''));
    const archive = await app.request('http://127.0.0.1:8790/api/mapping/projects/p/export.package', {
      headers: { Origin: 'http://127.0.0.1:8790', Authorization: `Bearer ${token}` },
    });
    expect(archive.status).toBe(200);
    const inspection = inspectPackage(Buffer.from(await archive.arrayBuffer()));
    expect(inspection).toMatchObject({ ok: true, manifest: { extensions: { forkwiseOrganize: [{ tasks: expect.arrayContaining(
      tasks.map((task, index) => expect.objectContaining({ id: task.id, usage: expect.objectContaining({
        attempts: [expect.objectContaining({ requestedModel: model, returnedModel: snapshots[index] })],
      }) })),
    ) }] } } });
    expect(external).toHaveBeenCalledTimes(3);
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('响应体未读完就关闭 Mapping，重开仍能看到收到的请求编号', async () => {
  let readingBody!: () => void;
  const bodyStarted = new Promise<void>(resolve => { readingBody = resolve; });
  const external = vi.fn<typeof fetch>(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
    },
    pull() { readingBody(); },
  }, { highWaterMark: 0 }), { headers: { 'x-request-id': 'req_blocked_body' } }));
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-openai-interrupted-'));
  const adapter = openAIOrganizeModel({
    apiKey: 'test-key', projectId: 'proj_fixture', retentionDisclosure: '测试留存说明。',
  }, external);
  let mapping = openMapping(directory, { organizeModel: adapter });
  const token = mapping.access.issue('human', ['*']);
  const human = mapping.access.authenticate(token);
  try {
    mapping.execute({ projectId: 'p', commandId: 'project', expected: null, type: 'project.create',
      payload: { name: '样例' } }, human);
    mapping.execute({ projectId: 'p', commandId: 'card', expected: null, type: 'thought.create',
      payload: { id: 'c', title: '标题', text: '', x: 0, y: 0 } }, human);
    const [card] = mapping.read({ type: 'project', projectId: 'p' }, human).cards;
    const { task } = await mapping.organize.start('p', {
      requestId: 'start', disclosureId: adapter.sendDisclosure!.id, mode: 'real', cardId: 'c', thoughtVersionId: card!.versionId,
      bodyVersionId: card!.body.versionId, includeTitle: true, blockIds: [],
    }, human);
    await bodyStarted;
    mapping.close();
    mapping = openMapping(directory);
    const receipt = { attempts: [{
      phase: 'generate', requestedModel: 'gpt-6-luna', returnedModel: null,
      responseReceived: true, providerRequestId: 'req_blocked_body',
      inputTokens: null, outputTokens: null,
    }] };
    expect(mapping.organize.get('p', task.id, mapping.access.authenticate(token))).toMatchObject({
      state: 'interrupted', usage: receipt, attempts: [{ state: 'interrupted', usage: receipt }],
    });
    expect(external).toHaveBeenCalledOnce();
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
