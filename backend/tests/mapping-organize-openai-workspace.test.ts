import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { openAIOrganizeModel } from '../src/mapping/organize-openai.js';
import { inspectPackage } from '../src/mapping/package-verify.js';
import { openMapping } from '../src/mapping/storage.js';

it('用 OpenAI 协议替身从 Mapping 请求整理，只发送所选正文并在明确添加后持久化', async () => {
  const model = 'gpt-4.1-mini-2025-04-14';
  const modelName = `openai/${model}`;
  const cardId = 'source-card-private-id';
  const projectId = 'project-private-id';
  const title = '未选择的样例标题';
  const selectedId = 'selected-block-private-id';
  const omittedText = '不发送的样例备注';
  const selectedText = '这段样例说明交付周期由四周延长至六周。';
  const candidate = { title: '交付周期延长', text: '样例中的交付周期从四周增加到六周。' };
  const apiKey = 'sk-synthetic-forkwise-test-key';
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
      usage: { input_tokens: 74, output_tokens: 19, total_tokens: 93 },
    }, { headers: { 'x-request-id': `req_openai_fixture_${vendorProjects.length}` } });
  });
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-openai-workspace-'));
  const origin = 'http://127.0.0.1:8790';
  const projectPath = `/api/mapping/projects/${projectId}`;
  const taskPath = `${projectPath}/organize/tasks`;
  let mapping = openMapping(directory, {
    organizeModel: openAIOrganizeModel({ apiKey, projectId: 'proj_fixture123', model }, external),
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
    const start = { requestId: 'original-start-request', mode: 'real', cardId,
      thoughtVersionId: source.versionId, bodyVersionId: source.body.versionId,
      includeTitle: false, blockIds: [selectedId] };

    const agent = mapping.access.issue('agent', [projectId]);
    expect((await request(taskPath, start, agent)).status).toBe(403);
    const earlyCancellation = await request(`${taskPath}/cancel-start`, { ...start, requestId: 'cancel-before-start' });
    expect(earlyCancellation.status).toBe(200);
    const cancelled = await earlyCancellation.json();
    expect(cancelled).toMatchObject({ mode: 'real', model: modelName, state: 'cancelled', attempt: 1 });
    expect(external).toHaveBeenCalledTimes(0);
    const started = await request(taskPath, start);
    expect(started.status).toBe(201);
    const { id } = await started.json();
    const readTask = async () => (await request(`${taskPath}/${id}`)).json();
    await vi.waitFor(async () => expect(await readTask()).toMatchObject({
      mode: 'real', model: modelName, state: 'succeeded', output: { candidate, gaps: [] },
      input: { title: null, omittedBlockCount: 1, blocks: [{ id: selectedId, text: selectedText }] },
      attempts: [{ usage: { cost: null, attempts: [{
        phase: 'generate', inputTokens: 74, outputTokens: 19, responseReceived: true,
        providerRequestId: 'req_openai_fixture_1',
      }] } }],
    }));
    expect(await (await request(projectPath)).json()).toEqual(before);
    expect(await (await request(taskPath, { ...start, requestId: 'same-scope-another-request' })).json())
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
      organizeModel: openAIOrganizeModel({ apiKey, projectId: 'proj_fixture456', model }, external),
    });
    app = createWorkspaceApp(mapping, origin, () => new Response(''));
    expect(await (await request(taskPath, start)).json()).toMatchObject({ id, applied: true });
    expect(external).toHaveBeenCalledTimes(1);
    const crossProjectRetry = await request(`${taskPath}/${cancelled.id}/retry`, {
      requestId: 'retry-after-openai-project-switch', attempt: 1,
    });
    expect(crossProjectRetry.status).toBe(409);
    expect(await crossProjectRetry.json()).toMatchObject({ code: 'ORGANIZE_MODEL_CHANGED' });
    expect(await (await request(`${taskPath}/${cancelled.id}`)).json()).toMatchObject({ state: 'cancelled', attempt: 1 });
    expect(external).toHaveBeenCalledTimes(1);
    const anotherProject = await request(taskPath, { ...start, requestId: 'same-scope-other-openai-project' });
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
    expect(inspectPackage(Buffer.from(await archive.arrayBuffer()))).toMatchObject({
      ok: true, manifest: { extensions: { forkwiseOrganize: [{ projectId, tasks: expect.arrayContaining([
        expect.objectContaining({ id, model: modelName, applied: true,
          usage: expect.objectContaining({ attempts: [expect.objectContaining({ providerRequestId: 'req_openai_fixture_1' })] }) }),
        expect.objectContaining({ id: secondTask.id, model: modelName, applied: false }),
      ]) }] } },
    });
    expect(external).toHaveBeenCalledTimes(2);
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
