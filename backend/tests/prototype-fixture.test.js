import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('迁移和 smoke 夹具在只有后端脚本的目录中仍可生成旧存档', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-prototype-fixture-'));
  try {
    cpSync(
      new URL('../scripts/prototype-fixture.cjs', import.meta.url),
      join(directory, 'prototype-fixture.cjs'),
    );
    cpSync(new URL('../scripts/fixtures/', import.meta.url), join(directory, 'fixtures'), {
      recursive: true,
    });
    const { fixture } = createRequire(import.meta.url)(join(directory, 'prototype-fixture.cjs'));
    const workspace = fixture();
    expect(workspace).toMatchObject({ format: 'forkwise-prototype-workspace', version: 1 });
    expect(workspace.projects).toHaveLength(1);
    expect(workspace.projects[0][1].study.sources.some((source) => source.kind === 'image')).toBe(
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
