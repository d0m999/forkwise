import { afterEach, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { CanvasPasteCommand } from '../src/mapping/snapshot-contracts.js';
import { closeGroupFixtures, groupFixture } from './group-fixture.js';

afterEach(closeGroupFixtures);

const YELLOW = '#f8dfc4';
const BLUE = '#d9e7f1';

type Fixture = ReturnType<typeof groupFixture>;
function seedTag(f: Fixture, id: string, name: string, color?: string) {
  f.execute({ type: 'tag.create', expected: null, payload: { id, name } });
  if (color) f.execute({ type: 'tag.update', expected: f.state().tags!.find(tag => tag.id === id)!.versionId, payload: { id, color } });
}
function seedTargetTag(f: Fixture, projectId: string, id: string, name: string, color?: string) {
  f.mapping.execute({ commandId: `tag-${projectId}-${id}`, projectId, type: 'tag.create', expected: null, payload: { id, name } }, f.human);
  if (color) f.mapping.execute({
    commandId: `tag-color-${projectId}-${id}`, projectId, type: 'tag.update',
    expected: f.mapping.read({ type: 'project', projectId }, f.human).tags!.find(tag => tag.id === id)!.versionId, payload: { id, color },
  }, f.human);
}

it('跨项目粘贴使用目标标签和新建媒体，不绑定源项目对象，源项目保持原样', () => {
  const f = groupFixture();
  f.mapping.execute({ commandId: 'project-q', projectId: 'q', type: 'project.create', expected: null, payload: { name: '目标' } }, f.human);
  seedTag(f, 'src-ai', 'AI', YELLOW);
  seedTag(f, 'src-defi', 'DeFi', YELLOW);
  seedTargetTag(f, 'q', 'dst-ai', 'ai', BLUE);
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'source-card', title: '市场观察', text: '需求增长', x: 10, y: 20 } });
  f.execute({ type: 'card.tags', expected: null, payload: { id: 'source-card', tagIds: ['src-defi', 'src-ai'] } });
  const base64 = createCanvas(2, 3).toBuffer('image/png').toString('base64');
  f.execute({ type: 'asset.save', expected: null, payload: { id: 'src-asset', name: '图.png', mime: 'image/png', base64 } });
  const source = f.state().cards.find(card => card.id === 'source-card')!;
  f.execute({ type: 'body.edit', expected: source.body.versionId, payload: { id: 'source-card', blocks: [
    { id: 'words', type: 'text', text: '需求增长' },
    { id: 'pic', type: 'image', assetId: 'src-asset', name: '图.png', mime: 'image/png', naturalWidth: 2, naturalHeight: 3 },
  ] } });
  const frozen = f.state();
  const sourceTagAi = frozen.tags!.find(tag => tag.id === 'src-ai')!;
  const sourceTagDefi = frozen.tags!.find(tag => tag.id === 'src-defi')!;
  const targetBefore = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  const card = frozen.cards.find(value => value.id === 'source-card')!;
  f.mapping.execute({
    commandId: 'paste-across', projectId: 'q', type: 'canvas.paste', expected: null,
    payload: {
      translation: { x: 30, y: 40 },
      library: {
        tags: [
          { id: sourceTagDefi.id, name: sourceTagDefi.name, color: sourceTagDefi.color },
          { id: sourceTagAi.id, name: sourceTagAi.name, color: sourceTagAi.color },
        ],
        assets: [{ id: 'src-asset', name: '图.png', mime: 'image/png', base64 }],
      },
      objects: [{
        kind: 'card', copyId: 'pasted-card', stack: card.item.createdOrder ?? 0, title: card.title,
        blocks: card.body.blocks, tagIds: ['src-defi', 'src-ai'], appearance: null, pose: card.item.pose,
      }],
      connectors: [],
    },
  }, f.human);
  const target = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  const pasted = target.cards.find(value => value.id === 'pasted-card')!;
  const reused = target.tags!.find(tag => tag.id === 'dst-ai')!;
  const created = target.tags!.find(tag => tag.name === 'DeFi')!;
  expect(pasted.id).not.toBe('source-card');
  expect(pasted.item.id).not.toBe(card.item.id);
  expect(pasted.item.pose).toEqual({ ...card.item.pose, x: card.item.pose.x + 30, y: card.item.pose.y + 40 });
  expect(pasted.cardTags!.tagIds).toEqual([created.id, 'dst-ai']);
  expect(created.id).not.toBe('src-defi');
  expect(created).toMatchObject({ name: 'DeFi', color: YELLOW, deleted: false });
  expect(reused).toMatchObject({ name: 'ai', color: BLUE });
  expect(reused.versionId).toBe(targetBefore.tags!.find(tag => tag.id === 'dst-ai')!.versionId);
  const image = pasted.body.blocks.find(block => block.type === 'image')!;
  expect(image.assetId).not.toBe('src-asset');
  expect(f.mapping.read({ type: 'asset', projectId: 'q', id: String(image.assetId) }, f.human)).toMatchObject({ name: '图.png', mime: 'image/png', base64 });
  expect(() => f.mapping.read({ type: 'asset', projectId: 'q', id: 'src-asset' }, f.human)).toThrowError(expect.objectContaining({ code: 'MEDIA_NOT_PERSISTED' }));
  expect(target.cards.map(value => value.id)).toEqual(['pasted-card']);
  expect(f.mapping.read({ type: 'project', projectId: 'p' }, f.human)).toEqual(frozen);
});

it('目标项目撤销粘贴只撤回新建标签和媒体，重做后重开仍恢复，复用标签不变', () => {
  const f = groupFixture();
  f.mapping.execute({ commandId: 'project-q', projectId: 'q', type: 'project.create', expected: null, payload: { name: '目标' } }, f.human);
  seedTag(f, 'src-ai', 'AI', YELLOW);
  seedTag(f, 'src-defi', 'DeFi', YELLOW);
  seedTargetTag(f, 'q', 'dst-ai', 'ai', BLUE);
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'source-card', title: '市场观察', text: '需求增长', x: 10, y: 20 } });
  f.execute({ type: 'card.tags', expected: null, payload: { id: 'source-card', tagIds: ['src-defi', 'src-ai'] } });
  const base64 = createCanvas(2, 3).toBuffer('image/png').toString('base64');
  f.execute({ type: 'asset.save', expected: null, payload: { id: 'src-asset', name: '图.png', mime: 'image/png', base64 } });
  const source = f.state().cards.find(card => card.id === 'source-card')!;
  f.execute({ type: 'body.edit', expected: source.body.versionId, payload: { id: 'source-card', blocks: [
    { id: 'words', type: 'text', text: '需求增长' },
    { id: 'pic', type: 'image', assetId: 'src-asset', name: '图.png', mime: 'image/png', naturalWidth: 2, naturalHeight: 3 },
  ] } });
  const frozen = f.state();
  const sourceTagAi = frozen.tags!.find(tag => tag.id === 'src-ai')!;
  const sourceTagDefi = frozen.tags!.find(tag => tag.id === 'src-defi')!;
  const reusedBefore = f.mapping.read({ type: 'project', projectId: 'q' }, f.human).tags!.find(tag => tag.id === 'dst-ai')!;
  const card = frozen.cards.find(value => value.id === 'source-card')!;
  f.mapping.execute({
    commandId: 'paste-across', projectId: 'q', type: 'canvas.paste', expected: null,
    payload: {
      translation: { x: 30, y: 40 },
      library: {
        tags: [
          { id: sourceTagDefi.id, name: sourceTagDefi.name, color: sourceTagDefi.color },
          { id: sourceTagAi.id, name: sourceTagAi.name, color: sourceTagAi.color },
        ],
        assets: [{ id: 'src-asset', name: '图.png', mime: 'image/png', base64 }],
      },
      objects: [{
        kind: 'card', copyId: 'pasted-card', stack: card.item.createdOrder ?? 0, title: card.title,
        blocks: card.body.blocks, tagIds: ['src-defi', 'src-ai'], appearance: null, pose: card.item.pose,
      }],
      connectors: [],
    },
  }, f.human);
  const pasted = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  const createdId = pasted.tags!.find(tag => tag.name === 'DeFi')!.id;
  const assetId = String(pasted.cards[0]!.body.blocks.find(block => block.type === 'image')!.assetId);
  const undoExpected = pasted.project.revision;
  f.mapping.execute({ commandId: 'undo-paste', projectId: 'q', type: 'history.undo', expected: undoExpected, payload: {} }, f.human);
  const undone = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  expect(undone.cards.map(value => value.id)).toEqual([]);
  expect(undone.tags!.find(tag => tag.id === createdId)).toMatchObject({ name: 'DeFi', color: YELLOW, deleted: true });
  expect(undone.tags!.find(tag => tag.id === 'dst-ai')).toMatchObject({ name: 'ai', color: BLUE, deleted: false, versionId: reusedBefore.versionId });
  expect(() => f.mapping.read({ type: 'asset', projectId: 'q', id: assetId }, f.human)).toThrowError(expect.objectContaining({ code: 'MEDIA_NOT_PERSISTED' }));
  expect(f.mapping.read({ type: 'project', projectId: 'p' }, f.human)).toEqual(frozen);
  f.mapping.execute({ commandId: 'redo-paste', projectId: 'q', type: 'history.redo', expected: undone.project.revision, payload: {} }, f.human);
  f.reopen();
  const redone = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  expect(redone.cards.map(value => value.id)).toEqual(['pasted-card']);
  expect(redone.cards[0]!.cardTags!.tagIds).toEqual([createdId, 'dst-ai']);
  expect(redone.tags!.find(tag => tag.id === createdId)).toMatchObject({ name: 'DeFi', color: YELLOW, deleted: false });
  expect(redone.tags!.find(tag => tag.id === 'dst-ai')).toMatchObject({ name: 'ai', color: BLUE, deleted: false, versionId: reusedBefore.versionId });
  expect(f.mapping.read({ type: 'asset', projectId: 'q', id: assetId }, f.human)).toMatchObject({ name: '图.png', mime: 'image/png', base64 });
  expect(f.mapping.read({ type: 'project', projectId: 'p' }, f.human)).toEqual(frozen);
});

it('目标媒体无效时不留下标签、卡片或资源，源项目不变', () => {
  const f = groupFixture();
  f.mapping.execute({ commandId: 'project-q', projectId: 'q', type: 'project.create', expected: null, payload: { name: '目标' } }, f.human);
  seedTag(f, 'src-defi', 'DeFi');
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'source-card', title: '市场观察', text: '需求增长', x: 10, y: 20 } });
  const frozen = f.state();
  const targetBefore = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  const card = frozen.cards[0]!;
  expect(() => f.mapping.execute({
    commandId: 'paste-bad', projectId: 'q', type: 'canvas.paste', expected: null,
    payload: {
      translation: { x: 30, y: 40 },
      library: {
        tags: [{ id: 'src-defi', name: 'DeFi', color: YELLOW }],
        assets: [{ id: 'src-asset', name: '图.png', mime: 'image/png', base64: 'aaaa' }],
      },
      objects: [{
        kind: 'card', copyId: 'pasted-card', stack: 1, title: card.title,
        blocks: [{ id: 'pic', type: 'image', assetId: 'src-asset', name: '图.png', mime: 'image/png', naturalWidth: 2, naturalHeight: 3 }],
        tagIds: ['src-defi'], appearance: null, pose: card.item.pose,
      }],
      connectors: [],
    },
  }, f.human)).toThrowError(expect.objectContaining({ code: 'INVALID_IMAGE' }));
  expect(f.mapping.read({ type: 'project', projectId: 'q' }, f.human)).toEqual(targetBefore);
  expect(f.mapping.read({ type: 'project', projectId: 'p' }, f.human)).toEqual(frozen);
});

it('同一项目粘贴附带材料时仍复用已有标签和媒体，不改写原标签', () => {
  const f = groupFixture();
  seedTag(f, 'src-ai', 'AI', YELLOW);
  const base64 = createCanvas(2, 3).toBuffer('image/png').toString('base64');
  f.execute({ type: 'asset.save', expected: null, payload: { id: 'src-asset', name: '图.png', mime: 'image/png', base64 } });
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'source-card', title: '市场观察', text: '需求增长', x: 10, y: 20 } });
  f.execute({ type: 'card.tags', expected: null, payload: { id: 'source-card', tagIds: ['src-ai'] } });
  const source = f.state().cards.find(card => card.id === 'source-card')!;
  f.execute({ type: 'body.edit', expected: source.body.versionId, payload: { id: 'source-card', blocks: [
    { id: 'words', type: 'text', text: '需求增长' },
    { id: 'pic', type: 'image', assetId: 'src-asset', name: '图.png', mime: 'image/png', naturalWidth: 2, naturalHeight: 3 },
  ] } });
  const before = f.state();
  const tag = before.tags!.find(value => value.id === 'src-ai')!;
  const card = before.cards.find(value => value.id === 'source-card')!;
  f.mapping.execute({
    commandId: 'paste-same', projectId: 'p', type: 'canvas.paste', expected: null,
    payload: {
      translation: { x: 24, y: 24 },
      library: { tags: [{ id: tag.id, name: tag.name, color: tag.color }], assets: [{ id: 'src-asset', name: '图.png', mime: 'image/png', base64 }] },
      objects: [{ kind: 'card', copyId: 'pasted-card', stack: 1, title: card.title, blocks: card.body.blocks, tagIds: ['src-ai'], appearance: null, pose: card.item.pose }],
      connectors: [],
    },
  }, f.human);
  const after = f.state();
  const pasted = after.cards.find(value => value.id === 'pasted-card')!;
  expect(pasted.cardTags!.tagIds).toEqual(['src-ai']);
  expect(pasted.body.blocks.find(block => block.type === 'image')!.assetId).toBe('src-asset');
  expect(after.tags).toEqual(before.tags);
  expect(f.mapping.read({ type: 'asset', projectId: 'p', id: 'src-asset' }, f.human)).toMatchObject({ name: '图.png', mime: 'image/png', base64 });
});

it('目标同名标签已删除时新建标签，不恢复被删除的标签', () => {
  const f = groupFixture();
  f.mapping.execute({ commandId: 'project-q', projectId: 'q', type: 'project.create', expected: null, payload: { name: '目标' } }, f.human);
  seedTargetTag(f, 'q', 'dst-ai', 'ai', BLUE);
  const colored = f.mapping.read({ type: 'project', projectId: 'q' }, f.human).tags!.find(tag => tag.id === 'dst-ai')!;
  f.mapping.execute({ commandId: 'tag-q-delete', projectId: 'q', type: 'tag.delete', expected: { tag: colored.versionId, cardTags: {} }, payload: { id: 'dst-ai' } }, f.human);
  seedTag(f, 'src-ai', 'AI', YELLOW);
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'source-card', title: '市场观察', text: '需求增长', x: 10, y: 20 } });
  const card = f.state().cards[0]!;
  f.mapping.execute({
    commandId: 'paste-deleted-name', projectId: 'q', type: 'canvas.paste', expected: null,
    payload: {
      translation: { x: 0, y: 0 },
      library: { tags: [{ id: 'src-ai', name: 'AI', color: YELLOW }], assets: [] },
      objects: [{ kind: 'card', copyId: 'pasted-card', stack: 1, title: card.title, blocks: card.body.blocks, tagIds: ['src-ai'], appearance: null, pose: card.item.pose }],
      connectors: [],
    },
  }, f.human);
  const target = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  const revived = target.tags!.find(tag => tag.id === 'dst-ai')!;
  const fresh = target.tags!.find(tag => tag.name === 'AI')!;
  expect(revived).toMatchObject({ name: 'ai', color: BLUE, deleted: true });
  expect(fresh.id).not.toBe('dst-ai');
  expect(fresh).toMatchObject({ name: 'AI', color: YELLOW, deleted: false });
  expect(target.cards[0]!.cardTags!.tagIds).toEqual([fresh.id]);
});

it('没有目标项目授权时拒绝跨项目粘贴，两边项目都不变', () => {
  const f = groupFixture();
  f.mapping.execute({ commandId: 'project-q', projectId: 'q', type: 'project.create', expected: null, payload: { name: '目标' } }, f.human);
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'source-card', title: '市场观察', text: '需求增长', x: 10, y: 20 } });
  const frozen = f.state();
  const targetBefore = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  const card = frozen.cards[0]!;
  const agent = f.mapping.access.authenticate(f.mapping.access.issue('agent', ['p'], undefined, undefined, ['p']));
  expect(() => f.mapping.execute({
    commandId: 'paste-denied', projectId: 'q', type: 'canvas.paste', expected: null,
    payload: {
      translation: { x: 30, y: 40 },
      objects: [{ kind: 'card', copyId: 'pasted-card', stack: 1, title: card.title, blocks: card.body.blocks, tagIds: null, appearance: null, pose: card.item.pose }],
      connectors: [],
    },
  }, agent)).toThrowError(expect.objectContaining({ code: 'PROJECT_FORBIDDEN' }));
  expect(f.mapping.read({ type: 'project', projectId: 'q' }, f.human)).toEqual(targetBefore);
  expect(f.mapping.read({ type: 'project', projectId: 'p' }, f.human)).toEqual(frozen);
});

it('撤销后重复同一粘贴命令不复活目标对象', () => {
  const f = groupFixture();
  f.mapping.execute({ commandId: 'project-q', projectId: 'q', type: 'project.create', expected: null, payload: { name: '目标' } }, f.human);
  seedTag(f, 'src-defi', 'DeFi');
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'source-card', title: '市场观察', text: '需求增长', x: 10, y: 20 } });
  f.execute({ type: 'card.tags', expected: null, payload: { id: 'source-card', tagIds: ['src-defi'] } });
  const frozen = f.state();
  const tag = frozen.tags!.find(value => value.id === 'src-defi')!;
  const card = frozen.cards[0]!;
  const command = {
    commandId: 'paste-once', projectId: 'q', type: 'canvas.paste', expected: null,
    payload: {
      translation: { x: 30, y: 40 },
      library: { tags: [{ id: tag.id, name: tag.name, color: tag.color }], assets: [] },
      objects: [{ kind: 'card', copyId: 'pasted-card', stack: 1, title: card.title, blocks: card.body.blocks, tagIds: ['src-defi'], appearance: null, pose: card.item.pose }],
      connectors: [],
    },
  };
  const receipt = f.mapping.execute(command, f.human);
  const pasted = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  f.mapping.execute({ commandId: 'undo-once', projectId: 'q', type: 'history.undo', expected: pasted.project.revision, payload: {} }, f.human);
  const undone = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  expect(f.mapping.execute(command, f.human)).toEqual(receipt);
  expect(f.mapping.read({ type: 'project', projectId: 'q' }, f.human)).toEqual(undone);
  expect(undone.cards).toEqual([]);
  expect(undone.tags!.find(value => value.name === 'DeFi')!.deleted).toBe(true);
  expect(f.mapping.read({ type: 'project', projectId: 'p' }, f.human)).toEqual(frozen);
});

it('分区粘贴的撤销同时撤回本次新建的标签和媒体，重做后恢复', () => {
  const f = groupFixture();
  f.mapping.execute({ commandId: 'project-q', projectId: 'q', type: 'project.create', expected: null, payload: { name: '目标' } }, f.human);
  seedTag(f, 'src-defi', 'DeFi', YELLOW);
  const base64 = createCanvas(2, 3).toBuffer('image/png').toString('base64');
  f.execute({ type: 'asset.save', expected: null, payload: { id: 'src-asset', name: '图.png', mime: 'image/png', base64 } });
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'source-card', title: '市场观察', text: '需求增长', x: 20, y: 30 } });
  f.execute({ type: 'card.tags', expected: null, payload: { id: 'source-card', tagIds: ['src-defi'] } });
  const source = f.state().cards.find(card => card.id === 'source-card')!;
  f.execute({ type: 'body.edit', expected: source.body.versionId, payload: { id: 'source-card', blocks: [
    { id: 'words', type: 'text', text: '需求增长' },
    { id: 'pic', type: 'image', assetId: 'src-asset', name: '图.png', mime: 'image/png', naturalWidth: 2, naturalHeight: 3 },
  ] } });
  const frozen = f.state();
  const card = frozen.cards[0]!;
  f.mapping.execute({
    commandId: 'paste-frame-library', projectId: 'q', type: 'canvas.paste', expected: null,
    payload: {
      version: 2, roots: ['frame-copy'], translation: { x: 30, y: 40 },
      containment: [{ copyId: 'card-copy', parentCopyId: 'frame-copy' }],
      library: {
        tags: [{ id: 'src-defi', name: 'DeFi', color: YELLOW }],
        assets: [{ id: 'src-asset', name: '图.png', mime: 'image/png', base64 }],
      },
      objects: [
        { kind: 'frame', copyId: 'frame-copy', stack: 2, name: '范围', background: '#abc', pose: { x: 0, y: 0, width: 400, height: 300 } },
        { kind: 'card', copyId: 'card-copy', stack: 1, title: card.title, blocks: card.body.blocks, tagIds: ['src-defi'], appearance: null, pose: card.item.pose },
      ],
      connectors: [],
    },
  }, f.human);
  const pasted = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  const createdId = pasted.tags!.find(tag => tag.name === 'DeFi')!.id;
  const assetId = String(pasted.cards[0]!.body.blocks.find(block => block.type === 'image')!.assetId);
  expect(pasted.frames!.map(frame => frame.id)).toEqual(['frame-copy']);
  expect(createdId).not.toBe('src-defi');
  expect(assetId).not.toBe('src-asset');
  f.mapping.execute({ commandId: 'undo-frame', projectId: 'q', type: 'history.undo', expected: pasted.project.revision, payload: {} }, f.human);
  const undone = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  expect(undone.cards).toEqual([]);
  expect(undone.frames ?? []).toEqual([]);
  expect(undone.tags!.find(tag => tag.id === createdId)).toMatchObject({ name: 'DeFi', color: YELLOW, deleted: true });
  expect(() => f.mapping.read({ type: 'asset', projectId: 'q', id: assetId }, f.human)).toThrowError(expect.objectContaining({ code: 'MEDIA_NOT_PERSISTED' }));
  f.mapping.execute({ commandId: 'redo-frame', projectId: 'q', type: 'history.redo', expected: undone.project.revision, payload: {} }, f.human);
  const redone = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  expect(redone.frames!.map(frame => frame.id)).toEqual(['frame-copy']);
  expect(redone.cards[0]!.cardTags!.tagIds).toEqual([createdId]);
  expect(redone.tags!.find(tag => tag.id === createdId)).toMatchObject({ name: 'DeFi', color: YELLOW, deleted: false });
  expect(f.mapping.read({ type: 'asset', projectId: 'q', id: assetId }, f.human)).toMatchObject({ name: '图.png', mime: 'image/png', base64 });
  expect(f.mapping.read({ type: 'project', projectId: 'p' }, f.human)).toEqual(frozen);
});

it('材料库接受快照已经允许的 101 个标签和 41 个媒体', () => {
  const tags = Array.from({ length: 101 }, (_, index) => ({ id: `tag-${index}`, name: `标签${index}`, color: YELLOW }));
  const assets = Array.from({ length: 41 }, (_, index) => ({ id: `asset-${index}`, name: '图.png', mime: 'image/png', base64: 'aa' }));
  const pose = { x: 0, y: 0, width: 280, height: 160 };
  expect(CanvasPasteCommand.parse({
    commandId: 'library-cap', projectId: 'q', type: 'canvas.paste', expected: null,
    payload: {
      translation: { x: 1, y: 1 },
      library: { tags, assets },
      objects: [
        {
          kind: 'card', copyId: 'card-a', stack: 1, title: '甲',
          blocks: [
            { id: 'words-a', type: 'text', text: '甲' },
            ...assets.map((asset, index) => ({ id: `block-${index}`, type: 'image', assetId: asset.id, name: asset.name, mime: asset.mime, naturalWidth: 2, naturalHeight: 3 })),
          ],
          tagIds: tags.slice(0, 100).map(tag => tag.id), appearance: null, pose,
        },
        { kind: 'card', copyId: 'card-b', stack: 2, title: '乙', blocks: [{ id: 'words-b', type: 'text', text: '乙' }], tagIds: [tags[100]!.id], appearance: null, pose },
      ],
      connectors: [],
    },
  }).payload.library).toMatchObject({ tags, assets });
});

it('跨项目粘贴保留 subtree 内部线和层级，外线只保留已冻结的自由端，源项目不变', () => {
  const f = groupFixture();
  f.mapping.execute({ commandId: 'project-q', projectId: 'q', type: 'project.create', expected: null, payload: { name: '目标' } }, f.human);
  f.execute({ type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id: 'source-frame', itemIds: [], pose: { x: 0, y: 0, width: 400, height: 300 } } });
  f.execute({ type: 'frame.edit', expected: f.state().frames!.find(value => value.id === 'source-frame')!.versionId, payload: { id: 'source-frame', name: '范围', background: '#abc' } });
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'source-card', title: '市场观察', text: '需求增长', x: 20, y: 30 } });
  f.execute({ type: 'text.create', expected: null, payload: { id: 'source-text', content: { runs: [{ text: '内部' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 100 }, pose: { x: 40, y: 80, width: 100, height: 27 } } });
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'outside', title: '外部', text: '', x: 800, y: 40 } });
  const source = f.state();
  const card = source.cards.find(value => value.id === 'source-card')!;
  const text = source.texts!.find(value => value.id === 'source-text')!;
  const outside = source.cards.find(value => value.id === 'outside')!;
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'internal', path: 'straight', start: { kind: 'bound', itemId: card.item.id, side: 'right' }, end: { kind: 'bound', itemId: text.item.id, side: 'left' } } });
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'external', path: 'straight', start: { kind: 'bound', itemId: card.item.id, side: 'left' }, end: { kind: 'bound', itemId: outside.item.id, side: 'right' } } });
  const frozen = f.state();
  f.mapping.execute({
    commandId: 'paste-tree', projectId: 'q', type: 'canvas.paste', expected: null,
    payload: {
      version: 2, roots: ['frame-copy'], translation: { x: 30, y: 40 },
      containment: [{ copyId: 'card-copy', parentCopyId: 'frame-copy' }, { copyId: 'text-copy', parentCopyId: 'frame-copy' }],
      objects: [
        { kind: 'frame', copyId: 'frame-copy', stack: 2, name: '范围', background: '#abc', pose: { x: 0, y: 0, width: 400, height: 300 } },
        { kind: 'card', copyId: 'card-copy', stack: 1, title: card.title, blocks: card.body.blocks, tagIds: null, appearance: null, pose: card.item.pose },
        { kind: 'text', copyId: 'text-copy', stack: 0, content: text.content, pose: text.item.pose },
      ],
      connectors: [
        { copyId: 'internal-copy', path: 'straight', start: { kind: 'bound', copyId: 'card-copy', side: 'right' }, end: { kind: 'bound', copyId: 'text-copy', side: 'left' } },
        { copyId: 'external-copy', path: 'straight', start: { kind: 'bound', copyId: 'card-copy', side: 'left' }, end: { kind: 'free', point: { x: 80, y: 40 } } },
      ],
    },
  }, f.human);
  const target = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  const pastedCard = target.cards.find(value => value.id === 'card-copy')!;
  const pastedText = target.texts!.find(value => value.id === 'text-copy')!;
  expect(target.frames!.find(value => value.id === 'frame-copy')!.pose).toEqual({ x: 30, y: 40, width: 400, height: 300 });
  expect(pastedCard.item.pose).toEqual({ ...card.item.pose, x: card.item.pose.x + 30, y: card.item.pose.y + 40 });
  expect(target.containment!.find(value => value.id === pastedCard.item.id)!.parent).toEqual({ kind: 'frame', id: 'frame-copy' });
  expect(target.containment!.find(value => value.id === pastedText.item.id)!.parent).toEqual({ kind: 'frame', id: 'frame-copy' });
  expect(target.connectors!.find(value => value.id === 'internal-copy')).toMatchObject({ start: { kind: 'bound', itemId: pastedCard.item.id, side: 'right' }, end: { kind: 'bound', itemId: pastedText.item.id, side: 'left' } });
  expect(target.connectors!.find(value => value.id === 'external-copy')).toMatchObject({ end: { kind: 'free', point: { x: 110, y: 80 } } });
  expect(target.connectors!.map(value => value.id).sort()).toEqual(['external-copy', 'internal-copy']);
  expect(target.cards.map(value => value.id)).not.toContain('source-card');
  expect(target.cards.map(value => value.id)).not.toContain('outside');
  expect(f.mapping.read({ type: 'project', projectId: 'p' }, f.human)).toEqual(frozen);
});

it('跨项目粘贴经真实 HTTP 进入同一执行，无目标授权则拒绝且两边不变', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-cross-project-http-'));
  const { openMapping } = await import('../src/mapping/storage.js');
  const mapping = openMapping(directory);
  const humanToken = mapping.access.issue('human', ['*']);
  const human = mapping.access.authenticate(humanToken);
  const agentToken = mapping.access.issue('agent', ['p'], undefined, undefined, ['p']);
  const run = (projectId: string, type: string, payload: object, expected: unknown = null) =>
    mapping.execute({ commandId: crypto.randomUUID(), projectId, type, expected, payload }, human);
  let app: ReturnType<typeof createWorkspaceApp>;
  const http = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
  await new Promise<void>(resolve => http.once('listening', resolve));
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  app = createWorkspaceApp(mapping, origin, () => new Response(''));
  const post = (command: object, token: string) => fetch(origin + '/api/mapping/execute', {
    method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command),
  });
  try {
    run('p', 'project.create', { name: '源' });
    run('q', 'project.create', { name: '目标' });
    run('p', 'tag.create', { id: 'src-defi', name: 'DeFi' });
    run('p', 'tag.update', { id: 'src-defi', color: YELLOW }, mapping.read({ type: 'project', projectId: 'p' }, human).tags!.find(tag => tag.id === 'src-defi')!.versionId);
    run('p', 'thought.create', { id: 'source-card', title: '市场观察', text: '需求增长', x: 10, y: 20 });
    run('p', 'card.tags', { id: 'source-card', tagIds: ['src-defi'] });
    const frozen = mapping.read({ type: 'project', projectId: 'p' }, human);
    const targetBefore = mapping.read({ type: 'project', projectId: 'q' }, human);
    const card = frozen.cards[0]!;
    const command = {
      commandId: 'paste-http', projectId: 'q', type: 'canvas.paste', expected: null,
      payload: {
        translation: { x: 30, y: 40 },
        library: { tags: [{ id: 'src-defi', name: 'DeFi', color: YELLOW }], assets: [] },
        objects: [{ kind: 'card', copyId: 'pasted-card', stack: 1, title: card.title, blocks: card.body.blocks, tagIds: ['src-defi'], appearance: null, pose: card.item.pose }],
        connectors: [],
      },
    };
    expect((await post(command, agentToken)).status).toBe(403);
    expect(mapping.read({ type: 'project', projectId: 'q' }, human)).toEqual(targetBefore);
    expect(mapping.read({ type: 'project', projectId: 'p' }, human)).toEqual(frozen);
    expect((await post(command, humanToken)).status).toBe(200);
    const target = mapping.read({ type: 'project', projectId: 'q' }, human);
    const created = target.tags!.find(tag => tag.name === 'DeFi')!;
    expect(target.cards.map(value => value.id)).toEqual(['pasted-card']);
    expect(created.id).not.toBe('src-defi');
    expect(target.cards[0]!.cardTags!.tagIds).toEqual([created.id]);
    expect(mapping.read({ type: 'project', projectId: 'p' }, human)).toEqual(frozen);
  } finally {
    if ('closeAllConnections' in http) http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    mapping.close();
  }
});
