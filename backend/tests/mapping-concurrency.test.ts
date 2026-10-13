import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';
import type { Mapping } from '../src/mapping/mapping.js';

const directories: string[] = [];
const connections: Mapping[] = [];
afterEach(() => {
  for (const mapping of connections.splice(0)) mapping.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-domains-'));
  directories.push(directory);
  const mapping = openMapping(directory);
  connections.push(mapping);
  const token = mapping.access.issue('human', ['*']);
  const actor = mapping.access.authenticate(token);
  mapping.execute(
    {
      commandId: 'project',
      projectId: 'p',
      type: 'project.create',
      expected: null,
      payload: { name: '研究' },
    },
    actor,
  );
  mapping.execute(
    {
      commandId: 'card',
      projectId: 'p',
      type: 'thought.create',
      expected: null,
      payload: { id: 'c', title: '标题', text: '原文', x: 10, y: 20 },
    },
    actor,
  );
  const read = () => mapping.read({ type: 'project', projectId: 'p' }, actor);
  return { directory, mapping, actor, token, read, original: read().cards[0]! };
}
it('正文与布局从同一快照保存，分域版本和历史互不覆盖', () => {
  const { mapping, actor, read, original } = fixture();
  mapping.execute(
    {
      commandId: 'body',
      projectId: 'p',
      type: 'body.edit',
      expected: original.body.versionId,
      payload: { id: 'c', text: '新正文' },
    },
    actor,
  );
  mapping.execute(
    {
      commandId: 'pose',
      projectId: 'p',
      type: 'pose.move',
      expected: original.item.versionId,
      payload: { id: 'c', x: 150, y: 200 },
    },
    actor,
  );
  const current = read().cards[0]!;
  expect(current.body.blocks).toEqual([{ ...original.body.blocks[0], text: '新正文' }]);
  expect(current.item.pose).toEqual({ x: 150, y: 200, width: 280, height: 160 });
  expect(current.body.versionId).not.toBe(original.body.versionId);
  expect(current.item.versionId).not.toBe(original.item.versionId);
  expect(current.versionId).toBe(original.versionId);
  const changes = mapping.observe({ projectId: 'p', afterRevision: 2 }, actor).changes;
  expect(changes.map((c) => c.changedIds)).toEqual([[original.body.id], [original.item.id]]);
  expect(changes[0]!.before).toEqual(original);
  expect(changes[1]!.after).toEqual(current);
});
it('跨 Body/Pose 命令一次校验全部 expected，一次提交；同正文冲突无部分写入', () => {
  const { mapping, actor, read, original } = fixture();
  const command = {
    commandId: 'both',
    projectId: 'p',
    type: 'card.edit',
    expected: { body: original.body.versionId, pose: original.item.versionId },
    payload: { id: 'c', text: '一起保存', x: 40, y: 60 },
  };
  expect(() =>
    mapping.execute({ ...command, expected: { ...command.expected, pose: 'stale' } }, actor),
  ).toThrow('布局已更新');
  expect(read().cards[0]).toEqual(original);
  expect(mapping.observe({ projectId: 'p', afterRevision: 2 }, actor).changes).toEqual([]);
  const receipt = mapping.execute(command, actor);
  expect(receipt).toMatchObject({ revision: 3, changedIds: [original.body.id, original.item.id] });
  const saved = read();
  expect(saved.cards[0]).toMatchObject({
    body: { blocks: [{ text: '一起保存' }] },
    item: { pose: { x: 40, y: 60 } },
  });
  expect(() =>
    mapping.execute(
      {
        ...command,
        commandId: 'stale-body',
        expected: { body: original.body.versionId, pose: saved.cards[0]!.item.versionId },
        payload: { ...command.payload, x: 999 },
      },
      actor,
    ),
  ).toThrow('正文已更新');
  expect(read()).toEqual(saved);
  expect(mapping.observe({ projectId: 'p', afterRevision: 2 }, actor).changes).toHaveLength(1);
  expect(
    mapping.execute(
      {
        ...command,
        commandId: 'noop',
        expected: { body: saved.cards[0]!.body.versionId, pose: saved.cards[0]!.item.versionId },
      },
      actor,
    ).changedIds,
  ).toEqual([]);
  expect(read()).toEqual(saved);
});
it('明确项目委托的 Agent 共用 execute，伪造身份/范围及撤销会话连重试也拒绝', () => {
  const { mapping, actor, read, original } = fixture();
  const token = mapping.access.issue('agent', ['p'], 60000, undefined, ['p']);
  const agent = mapping.access.authenticate(token);
  const command = {
    commandId: 'agent-edit',
    projectId: 'p',
    type: 'body.edit',
    expected: original.body.versionId,
    payload: { id: 'c', text: '受委托写入' },
  };
  mapping.execute(command, agent);
  expect(read().cards[0]!.body.blocks[0]!.text).toBe('受委托写入');
  expect(mapping.observe({ projectId: 'p', afterRevision: 2 }, actor).changes[0]!.actor).toEqual(
    agent.actor,
  );
  expect(() => mapping.execute(command, { ...agent, actor: actor.actor })).toThrow('可信');
  expect(() => mapping.read({ type: 'projects' }, { ...agent, projects: ['*'] })).toThrow('可信');
  expect(() => mapping.execute({ ...command, projectId: 'other' }, agent)).toThrow('授权');
  const readOnly = mapping.access.authenticate(mapping.access.issue('agent', ['p']));
  expect(() => mapping.execute(command, readOnly)).toThrow('委托');
  mapping.access.revoke(agent.tokenHash);
  expect(() => mapping.execute(command, agent)).toThrow('会话');
  expect(() => mapping.read({ type: 'project', projectId: 'p' }, agent)).toThrow('会话');
  expect(() => mapping.observe({ projectId: 'p', afterRevision: 0 }, agent)).toThrow('会话');
});
it('不可变 Body/Pose 版本可独立读取，重启后规范重试返回原回执，即使 expected 已过期', () => {
  const { mapping, directory, actor, token, original, read } = fixture();
  const command = {
    commandId: 'both',
    projectId: 'p',
    type: 'card.edit',
    expected: { body: original.body.versionId, pose: original.item.versionId },
    payload: { id: 'c', text: '第二版', x: 40, y: 60 },
  };
  const receipt = mapping.execute(command, actor);
  const current = read().cards[0]!;
  mapping.close();
  connections.splice(connections.indexOf(mapping), 1);
  const reopened = openMapping(directory);
  connections.push(reopened);
  const session = reopened.access.authenticate(token);
  expect(
    reopened.execute(
      {
        payload: { y: 60, x: 40, text: '第二版', id: 'c' },
        expected: { pose: original.item.versionId, body: original.body.versionId },
        type: 'card.edit',
        projectId: 'p',
        commandId: 'both',
      },
      session,
    ),
  ).toEqual(receipt);
  for (const card of [original, current]) {
    expect(
      reopened.read(
        {
          type: 'version',
          projectId: 'p',
          domain: 'body',
          id: card.body.id,
          versionId: card.body.versionId,
        },
        session,
      ),
    ).toEqual(card.body);
    expect(
      reopened.read(
        {
          type: 'version',
          projectId: 'p',
          domain: 'pose',
          id: card.item.id,
          versionId: card.item.versionId,
        },
        session,
      ),
    ).toEqual(card.item);
  }
  expect(() =>
    reopened.execute({ ...command, payload: { ...command.payload, text: '不同请求' } }, session),
  ).toThrow('命令编号');
  expect(reopened.observe({ projectId: 'p', afterRevision: 2 }, session).changes).toHaveLength(1);
});
it.each(['versions', 'history', 'receipt'] as const)(
  '存储故障 %s 回滚版本、当前投影、历史、delta 和 receipt，原命令可重试',
  (phase) => {
    const { mapping, directory, token, original, read } = fixture();
    const before = read();
    let failedVersion: string | undefined;
    const failing = openMapping(directory, {
      checkpoint: (at, change) => {
        if (at === phase) {
          if ('body' in change.after) failedVersion = change.after.body.versionId;
          throw new Error('INJECTED_STORAGE_FAILURE');
        }
      },
    });
    connections.push(failing);
    const actor = failing.access.authenticate(token);
    const command = {
      commandId: 'fault',
      projectId: 'p',
      type: 'card.edit',
      expected: { body: original.body.versionId, pose: original.item.versionId },
      payload: { id: 'c', text: '原子内容', x: 123, y: 456 },
    };
    expect(() => failing.execute(command, actor)).toThrow('INJECTED_STORAGE_FAILURE');
    expect(read()).toEqual(before);
    expect(mapping.observe({ projectId: 'p', afterRevision: 2 }, actor).changes).toEqual([]);
    expect(failedVersion).toBeTruthy();
    expect(() =>
      mapping.read(
        {
          type: 'version',
          projectId: 'p',
          domain: 'body',
          id: original.body.id,
          versionId: failedVersion!,
        },
        actor,
      ),
    ).toThrow('版本不存在');
    const receipt = mapping.execute(command, actor);
    expect(receipt.revision).toBe(3);
    expect(read().cards[0]).toMatchObject({
      body: { blocks: [{ text: '原子内容' }] },
      item: { pose: { x: 123, y: 456 } },
    });
    expect(mapping.execute(command, actor)).toEqual(receipt);
    expect(mapping.observe({ projectId: 'p', afterRevision: 2 }, actor).changes).toHaveLength(1);
  },
);

it.each(['independent', 'same-body', 'same-command'] as const)(
  '两进程真实 SQLite 写连接竞争：%s',
  async (mode) => {
    const { directory, mapping, actor, original, read } = fixture();
    const { fork } = await import('node:child_process');
    const workers = [0, 1].map(() =>
      fork(new URL('./mapping-race-worker.ts', import.meta.url), [directory], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      }),
    );
    try {
      await Promise.all(
        workers.map(
          (worker) =>
            new Promise<void>((resolve, reject) => {
              worker.on('message', (message: { ready?: boolean }) => {
                if (message.ready) resolve();
              });
              worker.once('error', reject);
              worker.once('exit', (code) => {
                if (code) reject(new Error(`worker exited ${code}`));
              });
            }),
        ),
      );
      const agent = mapping.access.authenticate(
        mapping.access.issue('agent', ['p'], 60000, undefined, ['p']),
      );
      const body = {
        commandId: 'race-body',
        projectId: 'p',
        type: 'body.edit',
        expected: original.body.versionId,
        payload: { id: 'c', text: '竞争正文' },
      };
      const second =
        mode === 'independent'
          ? {
              commandId: 'race-pose',
              projectId: 'p',
              type: 'pose.move',
              expected: original.item.versionId,
              payload: { id: 'c', x: 88, y: 99 },
            }
          : mode === 'same-command'
            ? body
            : { ...body, commandId: 'other-body', payload: { id: 'c', text: '另一正文' } };
      const results = await Promise.all(
        workers.map(
          (worker, index) =>
            new Promise<{ receipt?: unknown; code?: string }>((resolve, reject) => {
              worker.on('message', (message: { receipt?: unknown; code?: string }) => {
                if (message.receipt || message.code) resolve(message);
              });
              worker.once('error', reject);
              worker.send({
                command: index ? second : body,
                actor: index && mode !== 'same-command' ? agent : actor,
              });
            }),
        ),
      );
      const changes = mapping.observe({ projectId: 'p', afterRevision: 2 }, actor).changes;
      if (mode === 'independent') {
        expect(results.every((r) => r.receipt)).toBe(true);
        expect(read().cards[0]).toMatchObject({
          body: { blocks: [{ text: '竞争正文' }] },
          item: { pose: { x: 88, y: 99 } },
        });
        expect(changes.map((c) => c.revision)).toEqual([3, 4]);
      } else if (mode === 'same-body') {
        expect(results.filter((r) => r.code === 'VERSION_CONFLICT')).toHaveLength(1);
        expect(results.filter((r) => r.receipt)).toHaveLength(1);
        expect(changes).toHaveLength(1);
        expect(read().cards[0]!.item).toEqual(original.item);
      } else {
        expect(results[0]!.receipt).toEqual(results[1]!.receipt);
        expect(changes).toHaveLength(1);
      }
      for (const change of changes)
        if ('body' in change.after)
          expect(
            mapping.read(
              {
                type: 'version',
                projectId: 'p',
                domain: 'body',
                id: change.after.body.id,
                versionId: change.after.body.versionId,
              },
              actor,
            ),
          ).toEqual(change.after.body);
    } finally {
      await Promise.all(
        workers.map(
          (worker) =>
            new Promise<void>((resolve) => {
              if (worker.exitCode !== null || worker.signalCode !== null) return resolve();
              worker.once('exit', () => resolve());
              worker.kill('SIGTERM');
            }),
        ),
      );
    }
  },
  15000,
);
