import { it, expect } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  symlinkSync,
  linkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';
import { setup, statement } from './helpers.js';

it('拒绝旧研究目录，旧结构化对象与历史的数据库字节及资源原件不变', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-legacy-protection-'));
  try {
    const old = setup(join(directory, 'research.sqlite'));
    old.write([statement('old', '旧研究不得迁移')]);
    old.db.close();
    writeFileSync(join(directory, 'original.bin'), Buffer.from('原始资料'));
    writeFileSync(join(directory, 'prototype-archive.json'), '{"cards":["旧原型存档"]}');
    const snapshot = () =>
      Object.fromEntries(
        readdirSync(directory).map((name) => [
          name,
          {
            hash: createHash('sha256')
              .update(readFileSync(join(directory, name)))
              .digest('hex'),
            mode: statSync(join(directory, name)).mode,
          },
        ]),
      );
    const before = snapshot();
    expect(() => openMapping(directory)).toThrow('目录');
    expect(snapshot()).toEqual(before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it('拒绝改名的未知数据库以及符号链接、硬链接，不改变其目标', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-unknown-protection-'));
  const external = mkdtempSync(join(tmpdir(), 'forkwise-link-target-'));
  try {
    const path = join(directory, 'workspace.sqlite');
    const target = join(external, 'research.sqlite');
    const old = setup(target);
    old.db.close();
    const bytes = readFileSync(target),
      mode = statSync(target).mode;
    writeFileSync(path, bytes);
    expect(() => openMapping(directory)).toThrow('数据库');
    expect(readFileSync(path)).toEqual(bytes);
    rmSync(path);
    symlinkSync(target, path);
    expect(() => openMapping(directory)).toThrow('链接');
    rmSync(path);
    linkSync(target, path);
    expect(() => openMapping(directory)).toThrow('链接');
    expect(readFileSync(target)).toEqual(bytes);
    expect(statSync(target).mode).toBe(mode);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
