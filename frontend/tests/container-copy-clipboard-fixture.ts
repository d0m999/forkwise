import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page, TestInfo } from '@playwright/test';
import type { ProjectState } from '../src/api';

// Expected bytes come from the same-revision public state and the documented v2
// format, before C. This helper never imports the production capture/parse code.
export function expectedContainerClipboard(state: ProjectState, roots: string[], canvasIds: string[]) {
  const inside = new Set(canvasIds), frames = state.frames!.filter(v => inside.has(v.id));
  const objects = [
    ...state.cards.filter(v => inside.has(v.item.id)).map(v => ({ sourceId: v.id, itemId: v.item.id, stack: v.item.createdOrder ?? 0,
      pose: v.item.pose, kind: 'card', title: v.title, blocks: v.body.blocks, tagIds: v.cardTags?.tagIds ?? null,
      appearance: v.appearance ? { titleColor: v.appearance.titleColor, showPreview: v.appearance.showPreview } : null,
      ...(v.item.heightPolicy ? { heightPolicy: v.item.heightPolicy } : {}) })),
    ...state.shapes!.filter(v => inside.has(v.item.id)).map(v => ({ sourceId: v.id, itemId: v.item.id, stack: v.item.createdOrder ?? 0, pose: v.item.pose, kind: 'shape', content: v.content })),
    ...state.groups!.filter(v => inside.has(v.itemId)).map(v => ({ kind: 'group', sourceId: v.id, itemId: v.itemId, stack: v.createdOrder, pose: v.bounds })),
    ...frames.map(v => ({ kind: 'frame', sourceId: v.id, itemId: v.id, stack: state.frames!.indexOf(v), pose: v.pose, name: v.name, background: v.background })),
  ];
  return { kind: 'forkwise-canvas-snapshot', version: 2, roots,
    containment: state.containment!.flatMap(edge => edge.parent && inside.has(edge.id) && inside.has(edge.parent.id) ? [{ itemId: edge.id, parentItemId: edge.parent.id }] : []),
    objects, connectors: [] };
}

export async function canvasClipboardGuard(page: Page, info: TestInfo, projectId: string, document: unknown, plainText: string, origin: string) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const raw = JSON.stringify(document), safeURL = page.url(), parsedURL = new URL(safeURL);
  if (parsedURL.origin !== origin || parsedURL.hash || parsedURL.username || parsedURL.password || page.mainFrame().url() !== safeURL) throw new Error('画布剪贴板 fixture 必须使用自有origin的完整无fragment页面URL');
  const native = process.env.FORKWISE_CANVAS_CLIPBOARD_GUARD;
  const directory = native ? mkdtempSync(join(tmpdir(), 'forkwise-issue44-clipboard-')) : null;
  const original = directory && join(directory, 'original.json'), own = directory && join(directory, 'own.json');
  const command = (...args: string[]) => execFileSync(native!, args, { encoding: 'utf8' }).trim();
  const expected = directory && join(directory, 'expected.json');
  let saved: { type: string; bytes: number[] }[][];
  try {
    if (expected) writeFileSync(expected, JSON.stringify({ schemaVersion: 1, syntheticProjectID: projectId,
      canvasJSONUTF8Base64: Buffer.from(raw).toString('base64'), plainTextUTF8Base64: Buffer.from(plainText).toString('base64'),
      customMapUTF8Base64: Buffer.from('{"application/x-forkwise-canvas":"org.w3.web-custom-format.type-0"}').toString('base64'),
      origin, sourceURLUTF8Base64: Buffer.from(safeURL).toString('base64'), sourceURLPolicy: 'required',
    }), { flag: 'wx', mode: 0o600 });
    saved = await page.evaluate(async () => Promise.all((await navigator.clipboard.read()).filter(item => item.types.length).map(async item =>
    Promise.all(item.types.map(async type => ({ type, bytes: [...new Uint8Array(await (await item.getType(type)).arrayBuffer())] }))))));
    if (native) command('save', original!);
  } catch (error) { if (directory) rmSync(directory, { recursive: true, force: true }); throw error; }
  let observed = false, nativeOwned = false;
  return {
    async copied() {
      if (page.url() !== safeURL || page.mainFrame().url() !== safeURL) throw new Error('复制期间页面URL改变，不能认领系统剪贴板');
      const actual = await page.evaluate(async () => {
        const items = await navigator.clipboard.read(), item = items.find(v => v.types.includes('web application/x-forkwise-canvas'));
        return { raw: item ? await (await item.getType('web application/x-forkwise-canvas')).text() : null, text: await navigator.clipboard.readText() };
      });
      if (actual.raw !== raw || actual.text !== plainText) throw new Error('实际画布剪贴板字节与复制前独立expected不一致');
      observed = true;
      if (native) {
        const check = spawnSync(native, ['check', original!], { encoding: 'utf8' });
        const unchanged = check.status === 0 && check.stdout === 'UNCHANGED\n' && check.stderr === '';
        if (!unchanged && !(check.status === 2 && check.stdout === '' && check.stderr === 'REFUSED EXTERNAL_CHANGE\n')) throw new Error('系统剪贴板原状态检查失败，未获得changed证明');
        const result = unchanged ? 'UNCHANGED' : command('save-own-canvas', own!, expected!);
        nativeOwned = result === 'SAVED_OWN_CANVAS';
        await info.attach('canvas-native-owned-result', { body: result, contentType: 'text/plain' });
      }
      return actual.raw;
    },
    async restore() {
      try {
        if (native) {
          const check = spawnSync(native, ['check', original!], { encoding: 'utf8' });
          if (check.status === 0 && check.stdout === 'UNCHANGED\n' && check.stderr === '') return;
          if (!(check.status === 2 && check.stdout === '' && check.stderr === 'REFUSED EXTERNAL_CHANGE\n')) throw new Error('系统剪贴板原状态检查失败，保留当前值');
          if (!nativeOwned) throw new Error('系统剪贴板没有本票owned证明，保留外部值');
          const result = command('restore', original!, own!);
          await info.attach('canvas-native-restoration', { body: result, contentType: 'text/plain' });
          return;
        }
        if (!observed) return;
        await page.evaluate(async ({ saved, raw, plainText }) => {
          const items = await navigator.clipboard.read(), item = items.find(v => v.types.includes('web application/x-forkwise-canvas'));
          if (!item || items.length !== 1 || item.types.length !== 2 || await (await item.getType('web application/x-forkwise-canvas')).text() !== raw || await navigator.clipboard.readText() !== plainText) return;
          if (saved.length) await navigator.clipboard.write(saved.map(item => new ClipboardItem(Object.fromEntries(item.map(v => [v.type, new Blob([new Uint8Array(v.bytes)], { type: v.type })])))));
          else await navigator.clipboard.writeText('');
        }, { saved, raw, plainText });
      } finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
    },
  };
}
