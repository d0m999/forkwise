import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApplication } from '../src/app.js';
import { createMcpServer } from '../src/mcp-server.js';

it('MCP SDK 协议真实往返并复用 API 的项目权限、幂等和人工确认约束', async () => {
  const origin = 'http://127.0.0.1:8787';
  const t = createApplication({ database: ':memory:', origin });
  const owner = { id: 'owner', type: 'human' as const };
  const project = t.write.createProject(owner, 'project-key', { name: 'MCP 项目' });
  const token = t.access.issue('agent', [project.id]);
  const server = createMcpServer({
    async call(path, method = 'GET', body, key) {
      const response = await t.app.request(origin + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.code + ': ' + result.message);
      return result;
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === 'forkwise_apply_operations')).toBe(true);
    expect(tools.tools.some((t) => t.name === 'forkwise_initial_research')).toBe(true);
    const request = {
      expected: {},
      commands: [
        {
          op: 'statement.create',
          id: 'ai_statement',
          data: {
            text: 'AI 提出的待研究主张',
            origin: 'ai',
            participation: 'candidate',
            stance: { value: 'pending', reason: '' },
            citations: [],
          },
        },
      ],
    };
    const first = await client.callTool({
      name: 'forkwise_apply_operations',
      arguments: { projectId: project.id, idempotencyKey: 'mcp-write-key', request },
    });
    expect(first.isError).not.toBe(true);
    const overview = await client.callTool({
      name: 'forkwise_read_research_results',
      arguments: { projectId: project.id },
    });
    expect(overview.isError).not.toBe(true);
    expect(overview.structuredContent).toMatchObject({
      response: { data: { targets: [{ target: { id: 'ai_statement' }, latest: null }] } },
    });
    const detail = await client.callTool({
      name: 'forkwise_read_research_results',
      arguments: { projectId: project.id, id: 'ai_statement', limit: 1 },
    });
    expect(detail.structuredContent).toMatchObject({
      response: { data: { checks: [], nextCursor: null } },
    });
    const deniedResults = await client.callTool({
      name: 'forkwise_read_research_results',
      arguments: { projectId: 'other-project', id: 'ai_statement' },
    });
    expect(deniedResults.isError).toBe(true);
    expect(JSON.stringify(deniedResults.content)).toContain('PROJECT_FORBIDDEN');
    expect(
      await client.callTool({
        name: 'forkwise_apply_operations',
        arguments: { projectId: project.id, idempotencyKey: 'mcp-write-key', request },
      }),
    ).toEqual(first);
    const actionHistory = await client.callTool({
      name: 'forkwise_read_action_history',
      arguments: { projectId: project.id },
    });
    expect(actionHistory.isError).not.toBe(true);
    const undoDenied = await client.callTool({
      name: 'forkwise_travel_history',
      arguments: {
        projectId: project.id,
        idempotencyKey: 'mcp-undo-denied',
        request: {
          direction: 'undo',
          expectedRevision: t.repo.project(project.id).revision,
          expectedHistoryVersion: t.write.history(project.id).version,
          expectedLayoutVersion: 0,
        },
      },
    });
    expect(undoDenied.isError).toBe(true);
    expect(JSON.stringify(undoDenied.content)).toContain('HUMAN_REQUIRED');
    expect(t.repo.snapshot(project.id).objects).toHaveLength(1);
    const denied = await client.callTool({
      name: 'forkwise_apply_operations',
      arguments: {
        projectId: project.id,
        idempotencyKey: 'mcp-human-key',
        request: {
          expected: { ai_statement: 1 },
          commands: [
            { op: 'stance.set', id: 'ai_statement', stance: { value: 'accepted', reason: '' } },
          ],
        },
      },
    });
    expect(denied.isError).toBe(true);
    expect(t.repo.snapshot(project.id).objects[0]?.data).toMatchObject({
      stance: { value: 'pending' },
    });
    const target = t.repo.snapshot(project.id).objects.find((e) => e.id === 'ai_statement')!;
    const binding = { target: { id: target.id, versionId: target.contentVersionId }, context: [] };
    const details = { event: '合成年度报告', goal: '核对合成预测', period: null, date: null };
    const proposal = await client.callTool({
      name: 'forkwise_apply_operations',
      arguments: {
        projectId: project.id,
        idempotencyKey: 'mcp-node-proposal',
        request: {
          expected: { ai_statement: 1 },
          commands: [
            { op: 'verification.propose', id: 'node_candidate', ...binding, details, gaps: [] },
          ],
        },
      },
    });
    expect(proposal.isError).not.toBe(true);
    const confirmation = await client.callTool({
      name: 'forkwise_apply_operations',
      arguments: {
        projectId: project.id,
        idempotencyKey: 'mcp-node-confirm',
        request: {
          expected: { ai_statement: 1 },
          commands: [{ op: 'verification.confirm', id: 'human_node', ...binding, details }],
        },
      },
    });
    expect(confirmation.isError).toBe(true);
    expect(
      t.repo.snapshot(project.id).objects.filter((e) => e.kind === 'verification_node'),
    ).toHaveLength(1);
    t.write.execute(project.id, owner, 'mcp-initial-material', {
      expected: {},
      commands: [
        {
          op: 'source.create',
          id: 'source',
          data: { title: '明确授权的材料', publisher: '', rights: 'authorized' },
        },
        {
          op: 'source.import',
          id: 'material',
          sourceId: 'source',
          text: '待研究观点',
          retrievedAt: '2020-01-01T00:00:00Z',
          publishedAt: null,
        },
      ],
    });
    const material = await client.callTool({
      name: 'forkwise_apply_operations',
      arguments: {
        projectId: project.id,
        idempotencyKey: 'mcp-material-scope',
        request: {
          expected: { source: 1 },
          commands: [
            {
              op: 'source.import',
              id: 'mcp_excerpt',
              sourceId: 'source',
              text: 'MCP 保存的一段摘录',
              retrievedAt: '2020-01-01T00:00:00Z',
              publishedAt: null,
              coverage: 'excerpt',
            },
          ],
        },
      },
    });
    expect(material.isError).not.toBe(true);
    expect(
      t.repo.snapshot(project.id).objects.find((e) => e.id === 'mcp_excerpt')?.data,
    ).toMatchObject({ coverage: 'excerpt' });
    const initial = await client.callTool({
      name: 'forkwise_initial_research',
      arguments: {
        projectId: project.id,
        idempotencyKey: 'mcp-initial-task',
        request: { sourceVersionIds: ['material'] },
      },
    });
    expect(initial.isError).not.toBe(true);
    expect(t.jobs.list(project.id).filter((j) => j.kind === 'workflow.initial')).toHaveLength(1);
    const fileRequest = {
      source: { title: 'Agent 明确提供的材料', publisher: '', rights: 'authorized' },
      file: {
        name: 'agent.html',
        mime: 'text/html',
        base64: Buffer.from('<html><body>Agent supplied material</body></html>').toString('base64'),
        publishedAt: null,
      },
    };
    const imported = await client.callTool({
      name: 'forkwise_import_file',
      arguments: {
        projectId: project.id,
        idempotencyKey: 'mcp-file-import',
        request: fileRequest,
      },
    });
    expect(imported.isError).not.toBe(true);
    expect(
      await client.callTool({
        name: 'forkwise_import_file',
        arguments: {
          projectId: project.id,
          idempotencyKey: 'mcp-file-import',
          request: fileRequest,
        },
      }),
    ).toEqual(imported);
    const forbiddenFile = await client.callTool({
      name: 'forkwise_import_file',
      arguments: {
        projectId: 'unauthorized-project',
        idempotencyKey: 'mcp-file-forbidden',
        request: fileRequest,
      },
    });
    expect(forbiddenFile.isError).toBe(true);
    expect(JSON.stringify(forbiddenFile.content)).toContain('PROJECT_FORBIDDEN');
  } finally {
    await client.close();
    await server.close();
    t.db.close();
  }
});
