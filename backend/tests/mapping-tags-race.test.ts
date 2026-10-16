import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';
import type { Receipt } from '../src/mapping/contracts.js';

it('两个真实进程在同一SQLite写事务竞争时大小写同名标签只创建一次且双方真实退出', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-tags-race-')), logs = mkdtempSync(join(tmpdir(), 'forkwise-tags-race-logs-'));
  const m = openMapping(directory), token = m.access.issue('human', ['*']), actor = m.access.authenticate(token);
  m.execute({ commandId: 'p', projectId: 'p', type: 'project.create', expected: null, payload: { name: '项目' } }, actor);
  const workers = [0, 1].map(index => {
    const started = new Date().toISOString(), argv = [new URL('./mapping-race-worker.ts', import.meta.url).pathname, directory];
    const child = fork(argv[0]!, argv.slice(1), { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout!.on('data', b => stdout.push(Buffer.from(b))); child.stderr!.on('data', b => stderr.push(Buffer.from(b)));
    let ready!: () => void, locked!: () => void, result!: (value: { receipt?: Receipt; code?: string }) => void;
    const prepared = new Promise<void>(resolve => ready = resolve), held = new Promise<void>(resolve => locked = resolve), outcome = new Promise<{ receipt?: Receipt; code?: string }>(resolve => result = resolve);
    child.on('message', (value: any) => { if (value.ready) ready(); else if (value.locked) locked(); else result(value); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const closed = new Promise<void>(resolve => child.once('close', (exit, signal) => {
      writeFileSync(join(logs, `${index}.stdout`), Buffer.concat(stdout), { mode: 0o600 }); writeFileSync(join(logs, `${index}.stderr`), Buffer.concat(stderr), { mode: 0o600 });
      writeFileSync(join(logs, `${index}.json`), JSON.stringify({ argv: [process.execPath, '--import', 'tsx', ...argv], cwd: process.cwd(), started, finished: new Date().toISOString(), pid: child.pid, parent: process.pid, kernelstart: 'NOT_CAPTURED_BY_TEST', exit, signal }), { mode: 0o600 }); resolve();
    }));
    return { child, prepared, held, outcome, exited, closed };
  });
  try {
    await Promise.all(workers.map(w => w.prepared));
    workers[0]!.child.send({ actor, command: { commandId: 'race-a', projectId: 'p', type: 'tag.create', expected: null, payload: { id: 'a', name: 'AI' } } });
    await workers[0]!.held;
    workers[1]!.child.send({ actor, command: { commandId: 'race-b', projectId: 'p', type: 'tag.create', expected: null, payload: { id: 'b', name: 'ai' } } });
    const results = await Promise.all(workers.map(w => w.outcome));
    expect(results.every(r => r.receipt && !r.code)).toBe(true); expect(results.map(r => r.receipt!.changedIds)).toEqual([['a'], []]);
    expect(await Promise.all(workers.map(w => w.exited))).toEqual([{ code: 0, signal: null }, { code: 0, signal: null }]);
    await Promise.all(workers.map(w => w.closed));
    const state = m.read({ type: 'project', projectId: 'p' }, actor);
    expect(state.tags).toMatchObject([{ id: 'a', name: 'AI', color: '#f1f0ec', deleted: false }]); expect(state.tags).toHaveLength(1);
    expect(m.read({ type: 'history', projectId: 'p' }, actor).undo).toHaveLength(1);
    expect(m.observe({ projectId: 'p', afterRevision: 1 }, actor).changes).toHaveLength(1);
  } finally {
    for (const worker of workers) { if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM'); }
    await Promise.all(workers.flatMap(w => [w.exited, w.closed])); m.close();
  }
}, 20000);
