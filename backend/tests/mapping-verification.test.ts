import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecClient } from '@forkwise/public-data-core';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { openMapping } from '../src/mapping/storage.js';
import { inspectPackage } from '../src/mapping/package-verify.js';
import { captureCutCommand } from '../src/mapping/cut-command.js';
import { readZip, writeZip } from '../src/mapping/zip-store.js';
import type { Card, Command, ProjectState } from '../src/mapping/contracts.js';
import type { OrganizeRequest, OrganizeTaskView } from '../src/mapping/organize-contracts.js';

const origin = 'http://127.0.0.1:8790';
const project = '/api/mapping/projects/p';
const tasks = `${project}/organize/tasks`;
const raw = readFileSync(new URL('./fixtures/verification-companyfacts.json', import.meta.url), 'utf8');
const url = 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000001234.json';
const fixture = () => new Response(raw, { headers: { 'Last-Modified': 'Wed, 19 Mar 2025 20:00:00 GMT' } });
const query = { cik: '1234', taxonomy: 'us-gaap', tag: 'Assets', unit: 'USD',
  periodStart: null, periodEnd: '2024-12-31', knownByDate: '2025-03-20' };

async function workspace(transport?: typeof fetch) {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-verify-'));
  const options = transport ? { verificationSource: { client: new SecClient({
    userAgent: 'Forkwise contact@example.test', cacheDirectory: null, request: transport,
  }) } } : {};
  let mapping = openMapping(directory, options);
  let app = createWorkspaceApp(mapping, origin, () => new Response(''));
  const token = mapping.access.issue('human', ['*']);
  const request = (path: string, body?: unknown, auth = token) => app.request(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const execute = (command: object, auth = token) =>
    request('/api/mapping/execute', { projectId: 'p', expected: null, ...command }, auth);
  const read = async (): Promise<ProjectState> => (await request(project)).json();
  const start = async (requestId: string, card: Card, verification: OrganizeRequest['verification'] = query, projectId = 'p') => {
    const response = await request(`/api/mapping/projects/${projectId}/organize/tasks`, {
      requestId, mode: 'real', cardId: card.id, thoughtVersionId: card.versionId, bodyVersionId: card.body.versionId,
      includeTitle: false, blockIds: [], verification,
    });
    expect(response.status).toBe(201);
    return (await response.json() as OrganizeTaskView).id;
  };
  const task = async (id: string, projectId = 'p'): Promise<OrganizeTaskView> =>
    (await request(`/api/mapping/projects/${projectId}/organize/tasks/${id}`)).json();
  await execute({ commandId: 'project', type: 'project.create', payload: { name: '研究' } });
  await execute({ projectId: 'other', commandId: 'other', type: 'project.create', payload: { name: '另一个项目' } });
  await execute({ commandId: 'card', type: 'thought.create', payload: { id: 'c', title: '原卡', text: '私人正文', x: 0, y: 0 } });
  return {
    request, execute, read, start, task,
    issue: (...args: Parameters<typeof mapping.access.issue>) => mapping.access.issue(...args),
    reopen: () => {
      mapping.close();
      mapping = openMapping(directory, options);
      app = createWorkspaceApp(mapping, origin, () => new Response(''));
    },
    close: () => { mapping.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

it('任务类别的缺省值和显式值分别读取整理与公开查证，拒绝拼错的类别', async () => {
  const w = await workspace(async () => fixture());
  try {
    const source = (await w.read()).cards[0]!;
    const verificationId = await w.start('kind-verification', source);
    const started = await w.request(tasks, {
      requestId: 'kind-organize', mode: 'simulate', cardId: source.id,
      thoughtVersionId: source.versionId, bodyVersionId: source.body.versionId, includeTitle: true, blockIds: [],
    });
    expect(started.status).toBe(201);
    const { id: organizeId } = await started.json() as OrganizeTaskView;
    for (const path of [tasks, `${project}/cards/${source.id}/organize/tasks`]) {
      expect(await (await w.request(path)).json()).toMatchObject([{ id: organizeId }]);
      expect(await (await w.request(`${path}?kind=organize`)).json()).toMatchObject([{ id: organizeId }]);
      expect(await (await w.request(`${path}?kind=verification`)).json()).toMatchObject([{ id: verificationId }]);
    }
    const status = `${project}/organize/status`;
    const organizeStatus = await (await w.request(status)).json();
    expect(await (await w.request(`${status}?kind=organize`)).json()).toEqual(organizeStatus);
    expect(await (await w.request(`${status}?kind=verification`)).json()).toMatchObject({ model: null, blockedReason: null });
    for (const path of [tasks, `${project}/cards/${source.id}/organize/tasks`, status]) {
      const invalid = await w.request(`${path}?kind=verfication`);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: 'INVALID_COMMAND' });
    }
  } finally { w.close(); }
});

it('按 SEC 精确范围保留冲突披露、原词元和原文，候选只经统一命令写入和恢复', async () => {
  const transport = vi.fn<typeof fetch>(async () => fixture());
  const w = await workspace(transport);
  try {
    const before = await w.read();
    const source = before.cards[0]!;
    const id = await w.start('lookup', source);
    await vi.waitFor(async () => expect((await w.task(id)).state).toBe('partial'));
    const lookup = await w.task(id);
    expect(transport).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({ redirect: 'error' }));
    expect(lookup).toMatchObject({
      usage: null, model: null, input: { title: null, blocks: [] }, output: { verification: {
        coverage: 'conflicting', inference: 'not_enabled', matchedRecords: 2, records: [
          { rawValue: '9007199254740993', filedOn: '2025-02-10', accession: '0000001234-25-000001', pointer: '/facts/us-gaap/Assets/units/USD/0/val' },
          { rawValue: '9007199254740994.00', filedOn: '2025-03-20', accession: '0000001234-25-000002', pointer: '/facts/us-gaap/Assets/units/USD/1/val' },
        ], evidence: { status: 'accessed', receipt: { url, retrievedAt: expect.any(String), httpLastModified: 'Wed, 19 Mar 2025 20:00:00 GMT' } },
      } },
    });
    expect(await w.read()).toEqual(before);
    expect(await (await w.request(tasks)).json()).toEqual([]);
    expect(await (await w.request(`${tasks}?kind=verification`)).json()).toMatchObject([{ id }]);
    const evidence = lookup.output!.verification!.evidence;
    if (evidence.status !== 'accessed') throw new Error('夹具原文未取得');
    const { hash, assetId } = evidence.receipt;
    const original = (projectId: string, auth?: string) =>
      w.request(`/api/mapping/projects/${projectId}/assets/${assetId}/content`, undefined, auth);
    expect(await (await original('p')).text()).toBe(raw);
    expect((await original('other')).status).toBe(404);
    const outside = w.issue('human', ['other']);
    const agent = w.issue('agent', ['p'], 60_000, undefined, ['p']);
    expect((await original('p', outside)).status).toBe(403);
    expect((await w.request(`${tasks}/${id}`, undefined, agent)).status).toBe(403);
    const add = { commandId: 'add', type: 'organize.add', payload: { taskId: id, attempt: 1, x: 310, y: 0 } };
    expect((await w.execute(add, agent)).status).toBe(403);
    const added = await w.execute(add);
    expect(added.status).toBe(200);
    const receipt = await added.json();
    expect(await (await w.execute(add)).json()).toEqual(receipt);
    expect((await w.execute({ ...add, commandId: 'repeat' })).status).toBe(409);
    const after = await w.read();
    expect(after.project.revision).toBe(before.project.revision + 1);
    expect(after.cards).toHaveLength(2);
    expect(after.cards[0]).toEqual(source);
    expect(after.cards[1]).toMatchObject({ verificationOrigin: { assetId, hash } });
    expect(after.cards[1]!.aiOrigin).toBeUndefined();
    expect(after.connectors).toEqual(before.connectors);
    const undo = await w.execute({ commandId: 'undo', type: 'history.undo', expected: after.project.revision, payload: {} });
    expect(undo.status).toBe(200);
    expect((await w.read()).cards).toEqual([source]);
    const redo = await w.execute({ commandId: 'redo', type: 'history.redo', expected: (await w.read()).project.revision, payload: {} });
    expect(redo.status).toBe(200);
    expect((await w.read()).cards[1]!.verificationOrigin).toEqual({ assetId, hash });
    const cut = captureCutCommand(await w.read(), { projectId: 'p', commandId: 'cut', cutId: 'cut',
      itemIds: [after.cards[1]!.item.id], groupIds: [], frameIds: [] });
    expect((await w.execute(cut)).status).toBe(200);
    const paste: Extract<Command, { type: 'canvas.paste-cut' }> = {
      projectId: 'p', commandId: 'paste', type: 'canvas.paste-cut',
      expected: { cut: 'cut', cutRevision: 0 }, payload: { cutId: 'cut', translation: { x: 10, y: 10 } },
    };
    expect((await w.execute(paste)).status).toBe(200);
    const durable = await w.read();
    w.reopen();
    expect(await w.read()).toEqual(durable);
    expect((await w.task(id)).candidateOnCanvas).toBe(true);
    const exported = await w.request(`${project}/export.package?revision=${durable.project.revision}`);
    const archive = Buffer.from(await exported.arrayBuffer());
    expect(inspectPackage(archive)).toMatchObject({ ok: true, manifest: { extensions: {
      forkwiseOrganize: [{ projectId: 'p', tasks: [expect.objectContaining({ id })] }],
    } } });
    expect((await w.execute({ projectId: 'restore', commandId: 'restore', type: 'project.import',
      payload: { name: '隔离恢复', base64: archive.toString('base64') } })).status).toBe(200);
    const restored = await (await w.request('/api/mapping/projects/restore')).json() as ProjectState;
    expect(restored.cards[1]!.id).not.toBe(after.cards[1]!.id);
    expect(restored.cards[1]!.verificationOrigin).toEqual({ assetId, hash });
    expect(await (await original('restore')).text()).toBe(raw);
    expect((await w.request(`/api/mapping/projects/restore/organize/tasks/${id}`)).status).toBe(404);
    const entries = readZip(archive);
    const manifest = JSON.parse(entries.get('forkwise-project.json')!.toString());
    const archived = manifest.extensions.forkwiseOrganize[0].tasks[0];
    const archiveWithUpdatedManifest = () => {
      entries.set('forkwise-project.json', Buffer.from(JSON.stringify(manifest)));
      return inspectPackage(writeZip([...entries].map(([name, data]) => ({ name, data }))));
    };
    const projected = manifest.mapping.cards[1];
    const projectedOrigin = projected.verificationOrigin;
    delete projected.verificationOrigin;
    manifest.mapping.stored.cards[1].json = JSON.stringify(projected);
    expect(archiveWithUpdatedManifest()).toMatchObject({
      failures: [expect.objectContaining({ code: 'VERSION_FIELD', path: expect.stringContaining('verificationOrigin') })],
    });
    projected.verificationOrigin = projectedOrigin;
    manifest.mapping.stored.cards[1].json = JSON.stringify(projected);
    archived.output.verification.coverage = 'matched';
    expect(archiveWithUpdatedManifest()).toMatchObject({
      failures: [expect.objectContaining({ code: 'VERIFICATION_EVIDENCE', actual: expect.stringContaining('披露冲突状态') })],
    });
    const disclosure = structuredClone(archived.output.verification);
    disclosure.coverage = 'conflicting';
    for (const records of [[disclosure.records[0], disclosure.records[0]], [disclosure.records[0]]]) {
      archived.output.verification = { ...disclosure, coverage: 'matched', matchedRecords: records.length, records };
      expect(archiveWithUpdatedManifest()).toMatchObject({
        failures: [expect.objectContaining({ code: 'VERIFICATION_EVIDENCE', actual: expect.stringContaining('查证匹配数') })],
      });
    }
    const candidateOutput = archived.output.candidate;
    archived.output.candidate = null;
    archived.output.verification = { ...disclosure, coverage: 'no_coverage', matchedRecords: 0, records: [] };
    expect(archiveWithUpdatedManifest()).toMatchObject({
      failures: [expect.objectContaining({ code: 'VERIFICATION_EVIDENCE', actual: expect.stringContaining('查证匹配数') })],
    });
    archived.output.candidate = candidateOutput;
    archived.output.verification = disclosure;
    archived.attempts[0].output.verification.records[0].rawValue = '9';
    expect(archiveWithUpdatedManifest()).toMatchObject({
      failures: [expect.objectContaining({ code: 'VERIFICATION_EVIDENCE', path: expect.stringContaining('attempts[0]') })],
    });
    const verifiedQuery = archived.verification;
    delete archived.verification;
    expect(archiveWithUpdatedManifest()).toMatchObject({ failures: expect.arrayContaining([
      expect.objectContaining({ code: 'VERIFICATION_EVIDENCE', actual: expect.stringContaining('查询') }),
    ]) });
    archived.verification = verifiedQuery;
    archived.attempts[0].output.verification.evidence = { status: 'not_accessed', reason: '矛盾夹具' };
    expect(archiveWithUpdatedManifest()).toMatchObject({ failures: expect.arrayContaining([
      expect.objectContaining({ code: 'VERIFICATION_EVIDENCE', actual: expect.stringContaining('未取得原文') }),
    ]) });
    archived.attempts[0].output.candidate = null;
    archived.attempts[0].output.verification.records = [];
    archived.attempts[0].output.verification.matchedRecords = 0;
    archived.attempts[0].output.verification.coverage = 'matched';
    expect(archiveWithUpdatedManifest()).toMatchObject({ failures: expect.arrayContaining([
      expect.objectContaining({ code: 'VERIFICATION_EVIDENCE', actual: expect.stringContaining('访问状态') }),
    ]) });

    const candidate = durable.cards[1]!;
    const frozen = {
      kind: 'card', copyId: 'frozen-copy', title: candidate.title, blocks: candidate.body.blocks, tagIds: null,
      stack: 0, appearance: null, pose: candidate.item.pose, verificationSource: {
        projectId: 'p', cardId: candidate.id, thoughtVersionId: candidate.versionId, bodyVersionId: candidate.body.versionId,
      },
    };
    expect((await w.execute({ commandId: 'edit-title', type: 'thought.title', expected: candidate.versionId,
      payload: { id: candidate.id, title: '修改后的候选标题' } })).status).toBe(200);
    const edited = await w.read();
    const remove = captureCutCommand(edited, { projectId: 'p', commandId: 'cut-edited', cutId: 'cut-edited',
      itemIds: [candidate.item.id], groupIds: [], frameIds: [] });
    expect((await w.execute(remove)).status).toBe(200);
    const duplicate = { commandId: 'frozen-paste', type: 'canvas.paste',
      payload: { objects: [frozen], connectors: [], translation: { x: 12, y: 12 } } };
    expect((await w.execute(duplicate)).status).toBe(200);
    expect((await w.read()).cards.find(card => card.id === frozen.copyId)?.verificationOrigin).toEqual({ assetId, hash });
    expect((await w.execute({ ...duplicate, commandId: 'forged-paste',
      payload: { ...duplicate.payload, objects: [{ ...frozen, copyId: 'forged', title: '伪造标题' }] } })).status).toBe(200);
    expect((await w.read()).cards.find(card => card.id === 'forged')?.verificationOrigin).toBeUndefined();
  } finally { w.close(); }
});

it('区分无覆盖、证据不足、未配置、访问失败，并排除已知日以后修订', async () => {
  let response = fixture;
  const w = await workspace(async () => response());
  try {
    const source = (await w.read()).cards[0]!;
    const samples = [
      [{ ...query, knownByDate: '2025-03-19' }, 'matched', 1],
      [{ ...query, unit: 'shares' }, 'no_coverage', 0],
      [{ ...query, knownByDate: '2024-12-31' }, 'insufficient', 0],
      [{ ...query, periodStart: '2024-01-01' }, 'matched', 1],
    ] as const;
    for (const [index, [verification, coverage, matchedRecords]] of samples.entries()) {
      const id = await w.start(`sample-${index}`, source, verification);
      await vi.waitFor(async () => expect((await w.task(id)).output?.verification).toMatchObject({ coverage, matchedRecords }));
    }
    response = () => new Response(raw.replace('"accn":"0000001234-25-000002",', ''));
    const beforeLate = await w.start('future-malformed', source, { ...query, knownByDate: '2025-03-19' });
    await vi.waitFor(async () => expect((await w.task(beforeLate)).output).toMatchObject({
      candidate: expect.any(Object), gaps: [], verification: { coverage: 'matched', matchedRecords: 1 },
    }));
    const incomplete = await w.start('in-scope-malformed', source);
    await vi.waitFor(async () => expect((await w.task(incomplete)).output).toMatchObject({
      candidate: null, verification: { coverage: 'insufficient', matchedRecords: 1 },
    }));
    response = () => new Response(raw.replace('"cik": 1234,', '"cik": 1234, "cik": 1234,'));
    const duplicate = await w.start('duplicate-json', source);
    await vi.waitFor(async () => expect((await w.task(duplicate)).output).toMatchObject({
      candidate: null, gaps: [expect.stringContaining('重复键')], verification: { coverage: 'insufficient' },
    }));
    response = () => new Response(raw.replace('"cik": 1234,', '"cik": [1234],'));
    const malformedSubject = await w.start('malformed-subject', source);
    await vi.waitFor(async () => expect((await w.task(malformedSubject)).output).toMatchObject({
      candidate: null, verification: { coverage: 'insufficient' },
    }));
    const many = JSON.parse(raw);
    const unitRows = many.facts['us-gaap'].Assets.units.USD;
    many.facts['us-gaap'].Assets.units.USD = Array.from({ length: 21 }, (_, index) => ({ ...unitRows[0], val: index }));
    response = () => new Response(JSON.stringify(many));
    const truncated = await w.start('bounded-display', source);
    await vi.waitFor(async () => expect((await w.task(truncated)).output?.verification).toMatchObject({
      coverage: 'insufficient', matchedRecords: 21,
    }));
    expect((await w.task(truncated)).output?.verification?.records).toHaveLength(20);
    response = () => new Response(raw + ' '.repeat(10 * 1024 * 1024));
    const large = await w.start('too-large-to-retain', source);
    await vi.waitFor(async () => expect((await w.task(large)).output).toMatchObject({
      candidate: null, verification: { coverage: 'insufficient', evidence: { status: 'not_retained' } },
    }));
    response = () => new Response(null, { status: 403 });
    const denied = await w.start('denied', source);
    await vi.waitFor(async () => expect(await w.task(denied)).toMatchObject({ state: 'failed', output: { candidate: null,
      verification: { coverage: 'unknown', evidence: { status: 'access_failed', httpStatus: 403 } } } }));
    const exported = await w.request(`${project}/export.package`);
    const archive = Buffer.from(await exported.arrayBuffer());
    expect(inspectPackage(archive)).toMatchObject({ ok: true, failures: [] });
    const entries = readZip(archive);
    const manifest = JSON.parse(entries.get('forkwise-project.json')!.toString());
    const incompleteTask = manifest.extensions.forkwiseOrganize[0].tasks.find((task: { id: string }) => task.id === incomplete);
    incompleteTask.output.verification.coverage = 'matched';
    incompleteTask.output.candidate = { title: '缺口被遮盖', text: '夹具' };
    entries.set('forkwise-project.json', Buffer.from(JSON.stringify(manifest)));
    expect(inspectPackage(writeZip([...entries].map(([name, data]) => ({ name, data }))))).toMatchObject({
      failures: [expect.objectContaining({ code: 'VERIFICATION_EVIDENCE', actual: expect.stringContaining('提取有缺口') })],
    });
  } finally { w.close(); }
  const missing = await workspace();
  try {
    const id = await missing.start('missing', (await missing.read()).cards[0]!);
    await vi.waitFor(async () => expect(await missing.task(id)).toMatchObject({
      state: 'failed', retryBlockedReason: expect.stringContaining('SEC_USER_AGENT'), output: { candidate: null,
        verification: { evidence: { status: 'not_accessed' }, inference: 'not_enabled' } },
    }));
  } finally { missing.close(); }
});

it('重复访问共用原文并保留每次回执，新失败后须明确采用旧结果', async () => {
  const large = raw + ' '.repeat(4 * 1024 * 1024);
  let forbidden = false;
  const w = await workspace(async () => forbidden ? new Response(null, { status: 403 }) : new Response(large));
  try {
    const source = (await w.read()).cards[0]!;
    const results: OrganizeTaskView[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await w.start(`fresh-${i}`, source);
      await vi.waitFor(async () => expect((await w.task(id)).state).toBe('partial'), { timeout: 3000 });
      results.push(await w.task(id));
    }
    const obtained = results.map(task => task.output?.verification?.evidence).flatMap(item => item?.status === 'accessed' ? [item.receipt] : []);
    expect(obtained).toHaveLength(4);
    expect(new Set(obtained.map(item => item.assetId)).size).toBe(1);
    expect(new Set(obtained.map(item => item.retrievedAt)).size).toBe(4);
    const exported = await w.request(`${project}/export.package`);
    const archive = Buffer.from(await exported.arrayBuffer());
    expect(inspectPackage(archive)).toMatchObject({ ok: true, failures: [], manifest: {
      resources: [{ id: obtained[0]!.assetId, sha256: obtained[0]!.hash }],
    } });
    const entries = readZip(archive);
    const manifest = JSON.parse(entries.get('forkwise-project.json')!.toString());
    delete manifest.mapping.assets[0].base64;
    entries.set('forkwise-project.json', Buffer.from(JSON.stringify(manifest)));
    const zipOnly = writeZip([...entries].map(([name, data]) => ({ name, data })));
    expect((await w.execute({ projectId: 'restore', commandId: 'restore', type: 'project.import',
      payload: { name: '重复查证项目', base64: zipOnly.toString('base64') } })).status).toBe(200);
    const restored = await (await w.request('/api/mapping/projects/restore')).json() as ProjectState;
    const freshInImport = await w.start('fresh-after-zip-only-import', restored.cards[0]!, query, 'restore');
    await vi.waitFor(async () => expect(await w.task(freshInImport, 'restore')).toMatchObject({
      state: 'partial', output: { verification: { evidence: { status: 'accessed', receipt: { assetId: obtained[0]!.assetId } } } },
    }), { timeout: 3000 });
    const taskId = results[0]!.id;
    forbidden = true;
    expect((await w.request(`${tasks}/${taskId}/retry`, { attempt: 1, requestId: 'retry-denied' })).status).toBe(200);
    await vi.waitFor(async () => expect(await w.task(taskId)).toMatchObject({
      state: 'partial', outputAttempt: 1,
      attempts: [expect.objectContaining({ state: 'partial' }), expect.objectContaining({
        state: 'failed', output: { candidate: null, gaps: [], verification: expect.objectContaining({ evidence: expect.objectContaining({ status: 'access_failed', httpStatus: 403 }) }) },
      })],
    }));
    const add = { commandId: 'ambiguous', type: 'organize.add', payload: { taskId, attempt: 2, x: 0, y: 0 } };
    expect((await w.execute(add)).status).toBe(409);
    expect((await w.execute({ ...add, commandId: 'explicit-first', payload: { ...add.payload, outputAttempt: 1 } })).status).toBe(200);
  } finally { w.close(); }
}, 15_000);

it('原文身份已被资料占用时结束这次查证并保留访问回执', async () => {
  const w = await workspace(async () => fixture());
  try {
    const id = `sec-companyfacts:${createHash('sha256').update(raw).digest('hex')}`;
    expect((await w.execute({ commandId: 'occupied', type: 'asset.save', payload: {
      id, kind: 'file', name: '原有资料.txt', mime: 'text/plain', base64: Buffer.from('existing').toString('base64'),
    } })).status).toBe(200);
    const taskId = await w.start('refuse-incompatible-asset', (await w.read()).cards[0]!);
    await vi.waitFor(async () => expect(await w.task(taskId)).toMatchObject({
      state: 'partial', output: { candidate: null, verification: { evidence: {
        status: 'not_retained', reason: expect.stringContaining('身份'),
      } } },
    }));
    expect(await (await w.request(`${project}/assets/${encodeURIComponent(id)}/content`)).text()).toBe('existing');
  } finally { w.close(); }
});

it('取消与重试隔离晚响应，正文版本过时后只能查看', async () => {
  let release: ((response: Response) => void) | undefined;
  const w = await workspace(async () => new Promise<Response>(resolve => { release = resolve; }));
  try {
    const source = (await w.read()).cards[0]!;
    const id = await w.start('delayed', source);
    await vi.waitFor(() => expect(release).toBeDefined());
    const original = release!;
    expect((await w.request(`${tasks}/${id}/cancel`, { attempt: 1 })).status).toBe(200);
    release = undefined;
    expect((await w.request(`${tasks}/${id}/retry`, { attempt: 1, requestId: 'retry' })).status).toBe(200);
    await vi.waitFor(() => expect(release).toBeDefined());
    original(fixture());
    expect((await w.task(id)).attempts[0]).toMatchObject({ state: 'cancelled', output: null });
    expect((await w.execute({ commandId: 'body', type: 'body.edit', expected: source.body.versionId,
      payload: { id: source.id, text: '已修改' } })).status).toBe(200);
    release!(fixture());
    await vi.waitFor(async () => expect(await w.task(id)).toMatchObject({ state: 'partial', freshness: 'changed', attempt: 2 }));
    expect((await w.execute({ commandId: 'stale', type: 'organize.add', payload: { taskId: id, attempt: 2, x: 0, y: 0 } })).status).toBe(409);
    expect((await w.read()).cards).toHaveLength(1);
    expect((await w.request(`${tasks}/${id}/retry`, { attempt: 2, requestId: 'stale-retry' })).status).toBe(409);
  } finally { w.close(); }
});
