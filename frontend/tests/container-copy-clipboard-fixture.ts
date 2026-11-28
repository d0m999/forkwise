import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { ProjectState } from '../src/api';

function expectedCard(card: ProjectState['cards'][number]) {
  return { sourceId: card.id, itemId: card.item.id, stack: card.item.createdOrder ?? 0,
    pose: card.item.pose, kind: 'card', title: card.title, blocks: card.body.blocks, tagIds: card.cardTags?.tagIds ?? null,
    appearance: card.appearance ? { titleColor: card.appearance.titleColor, showPreview: card.appearance.showPreview } : null,
    ...(card.item.heightPolicy ? { heightPolicy: card.item.heightPolicy } : {}) };
}

// Expected bytes come from the same-revision public state and the documented v2
// format, before C. This helper never imports the production capture/parse code.
export function expectedContainerClipboard(state: ProjectState, roots: string[], canvasIds: string[]) {
  const inside = new Set(canvasIds), frames = state.frames!.filter(v => inside.has(v.id));
  const objects = [
    ...state.cards.filter(v => inside.has(v.item.id)).map(expectedCard),
    ...state.shapes!.filter(v => inside.has(v.item.id)).map(v => ({ sourceId: v.id, itemId: v.item.id, stack: v.item.createdOrder ?? 0, pose: v.item.pose, kind: 'shape', content: v.content })),
    ...state.groups!.filter(v => inside.has(v.itemId)).map(v => ({ kind: 'group', sourceId: v.id, itemId: v.itemId, stack: v.createdOrder, pose: v.bounds })),
    ...frames.map(v => ({ kind: 'frame', sourceId: v.id, itemId: v.id, stack: state.frames!.indexOf(v), pose: v.pose, name: v.name, background: v.background })),
  ];
  return { kind: 'forkwise-canvas-snapshot', version: 2, roots,
    containment: state.containment!.flatMap(edge => edge.parent && inside.has(edge.id) && inside.has(edge.parent.id) ? [{ itemId: edge.id, parentItemId: edge.parent.id }] : []),
    objects, connectors: [] };
}

function writeNativeExpected(path: string, projectId: string, raw: string, text: string, url: string) {
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, syntheticProjectID: projectId,
    canvasJSONUTF8Base64: Buffer.from(raw).toString('base64'), plainTextUTF8Base64: Buffer.from(text).toString('base64'),
    customMapUTF8Base64: Buffer.from('{"application/x-forkwise-canvas":"org.w3.web-custom-format.type-0"}').toString('base64'),
    origin: new URL(url).origin, sourceURLUTF8Base64: Buffer.from(url).toString('base64'), sourceURLPolicy: 'required',
  }), { flag: 'wx', mode: 0o600 });
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
    if (expected) writeNativeExpected(expected, projectId, raw, plainText, safeURL);
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

type ClipboardAsset = { id: string; name: string; mime: string; base64: string };
export type NativeCanvasClipboard = {
  write(state: ProjectState, cardId: string, kind: 'copy' | 'cut', action: () => Promise<void>, assets?: ClipboardAsset[], beforeWrite?: () => Promise<void>): Promise<string>;
  paste(action: () => Promise<void>): Promise<void>;
};

type PastePage = Window & {
  __forkwisePrepareCanvasPaste(raw: string, text: string): Promise<void>;
  __forkwiseCanvasPasteResult(): 'ready' | 'checking' | 'delivered' | 'blocked' | undefined;
};

export async function withNativeCanvasClipboard<T>(page: Page, origin: string, run: (guard: NativeCanvasClipboard) => Promise<T>): Promise<T> {
  const native = process.env.FORKWISE_CANVAS_CLIPBOARD_GUARD;
  if (!native?.startsWith('/') || test.info().config.workers !== 1)
    throw new Error('真实剪贴板用例需要 FORKWISE_CANVAS_CLIPBOARD_GUARD 的绝对路径和 --workers=1');
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-native-clipboard-'));
  const original = join(directory, 'original.json');
  const command = (...args: string[]) => {
    const result = spawnSync(native, args, { encoding: 'utf8' });
    if (result.status !== 0 || result.stderr) {
      const reason = /^REFUSED [A-Z_]+\n$/.test(result.stderr ?? '') ? ` (${result.stderr.trim()})` : '';
      throw new Error('系统剪贴板守卫拒绝 ' + args[0] + reason);
    }
    return result.stdout.trim();
  };
  const unchanged = (path: string) => {
    const result = spawnSync(native, ['check', path], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout === 'UNCHANGED\n' && result.stderr === '') return true;
    if (result.status === 2 && result.stdout === '' && result.stderr === 'REFUSED EXTERNAL_CHANGE\n') return false;
    throw new Error('无法核对系统剪贴板完整状态');
  };
  type Expected = { raw: string; file: string; owned: string };
  let saved = false, closing = false, closed = false;
  let lastOwned: (Expected & { text: string }) | undefined, nextFile = 0;
  let attempt: { url: string; text: string; remaining: Expected[]; first: string; firstConfirmed: boolean; beforeWrite?: () => Promise<void> } | undefined;
  let armed: { candidate: Expected; done: Promise<void>; finish: () => void } | undefined;
  let refusal: Error | undefined;
  try {
    await page.addInitScript(origin => {
      if (window !== window.top || location.origin !== origin) return;
      const scope = window as unknown as PastePage;
      const clipboard = navigator.clipboard, read = clipboard.read.bind(clipboard);
      const readText = clipboard.readText.bind(clipboard);
      const format = 'web application/x-forkwise-canvas';
      let prepared: { raw: string; text: string; status: 'ready' | 'checking' | 'delivered' | 'blocked' } | undefined;
      const verifiedItems = async (raw: string, text: string) => {
        const items = await read(), item = items[0];
        const matches = async (type: string, expected: string) => {
          const actual = new Uint8Array(await (await item!.getType(type)).arrayBuffer());
          const wanted = new TextEncoder().encode(expected);
          return actual.length === wanted.length && actual.every((byte, index) => byte === wanted[index]);
        };
        if (!document.hasFocus() || items.length !== 1 || !item || item.types.length !== 2 ||
            !item.types.includes(format) || !item.types.includes('text/plain') ||
            !(await matches(format, raw)) || !(await matches('text/plain', text)))
          throw new Error('浏览器剪贴板与本次自有写入不符');
        return items;
      };
      scope.__forkwisePrepareCanvasPaste = async (raw, text) => {
        prepared = undefined;
        await verifiedItems(raw, text);
        prepared = { raw, text, status: 'ready' };
      };
      scope.__forkwiseCanvasPasteResult = () => prepared?.status;
      // Chromium may expose only plain text in the trusted event. The product
      // still calls the original read APIs, with an exact check at that time.
      Object.defineProperty(clipboard, 'read', { value: async () => {
        const current = prepared;
        if (current?.status !== 'checking') return [];
        try { return await verifiedItems(current.raw, current.text); }
        catch { current.status = 'blocked'; throw new Error('粘贴读取与本次自有写入不符'); }
      }});
      Object.defineProperty(clipboard, 'readText', { value: async () => {
        const current = prepared;
        if (current?.status !== 'checking') return '';
        try {
          const text = await readText();
          if (text !== current.text) throw new Error('剪贴板文字已变化');
          current.status = 'delivered';
          return text;
        } catch { current.status = 'blocked'; throw new Error('粘贴读取与本次自有写入不符'); }
      }});
      window.addEventListener('paste', event => {
        const data = event.clipboardData;
        if (prepared?.status === 'ready' && event.isTrusted && data &&
            data.files.length === 0 && data.types.every(type => type === 'text/plain' || type === format) &&
            data.getData('text/plain') === prepared.text &&
            (!data.types.includes(format) || data.getData(format) === prepared.raw)) {
          prepared.status = data.types.includes(format) ? 'delivered' : 'checking';
          return;
        }
        if (prepared) prepared.status = 'blocked';
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    }, origin);
    await page.exposeBinding('__forkwiseNativeCanvasWrite', async ({ frame }, phase: 'before' | 'after', raw?: number[], text?: number[]) => {
      try {
        if (closed || frame !== page.mainFrame() || !attempt || frame.url() !== attempt.url) throw new Error('当前没有受控剪贴板动作');
        if (phase === 'before') {
          const candidate = attempt.remaining[0];
          if (closing || armed || !candidate || !raw || !text ||
              !Buffer.from(candidate.raw).equals(Buffer.from(raw)) || !Buffer.from(attempt.text).equals(Buffer.from(text)) ||
              (candidate.raw !== attempt.first && !attempt.firstConfirmed))
            throw new Error('写入提议与当前单卡动作不符');
          const current = attempt;
          if (!current.firstConfirmed) await current.beforeWrite?.();
          if (closing || armed || attempt !== current) throw new Error('剪贴板动作已收尾');
          if (!unchanged(lastOwned?.owned ?? original)) throw new Error('系统剪贴板已被其他操作更改，拒绝写入');
          const completion = Promise.withResolvers<void>();
          current.remaining.shift();
          armed = { candidate, done: completion.promise, finish: completion.resolve };
        } else {
          const pending = armed;
          if (!pending) throw new Error('系统剪贴板写入缺少预声明');
          try {
            const { candidate } = pending;
            if (unchanged(lastOwned?.owned ?? original)) throw new Error('系统剪贴板未确认新写入');
            if (command('save-own-canvas', candidate.owned, candidate.file) !== 'SAVED_OWN_CANVAS')
              throw new Error('系统剪贴板缺少精确归属回执');
            lastOwned = { ...candidate, text: attempt.text };
            attempt.firstConfirmed = true;
          } finally {
            armed = undefined;
            pending.finish();
          }
        }
      } catch (error) {
        refusal = error as Error;
        throw error;
      }
    });
    const complete = await run({ async paste(action) {
      const owned = lastOwned;
      if (armed || refusal || !owned || !unchanged(owned.owned))
        throw new Error('系统剪贴板已变化或无确认的自有内容，拒绝粘贴');
      await page.evaluate(({ raw, text }) => (window as unknown as PastePage).__forkwisePrepareCanvasPaste(raw, text),
        { raw: owned.raw, text: owned.text });
      if (!unchanged(owned.owned)) throw new Error('系统剪贴板在准备粘贴时已变化');
      await action();
      const result = () => page.evaluate(() => (window as unknown as PastePage).__forkwiseCanvasPasteResult());
      await expect.poll(async () => {
        const status = await result();
        return status === 'delivered' || status === 'blocked';
      }).toBe(true);
      if (await result() !== 'delivered') throw new Error('剪贴板事件或读回与预声明不符，本次验收拒绝');
    }, async write(state, cardId, kind, action, assets = [], beforeWrite) {
      if (armed || refusal) throw refusal ?? new Error('上次系统剪贴板写入尚未确认');
      const url = page.url(), parsed = new URL(url);
      if (parsed.origin !== origin || parsed.hash || parsed.username || parsed.password || page.mainFrame().url() !== url)
        throw new Error('系统剪贴板用例要求合成工作区同源无 fragment 页面');
      const card = state.cards.find(value => value.id === cardId)!;
      const tags = (card.cardTags?.tagIds ?? []).map(id => {
        const tag = state.tags!.find(value => value.id === id && !value.deleted)!;
        return { id: tag.id, name: tag.name, color: tag.color };
      });
      const text = card.title || '画布对象';
      const projectId = state.project.id;
      const document = { kind: 'forkwise-canvas-snapshot', version: 1, objects: [expectedCard(card)], connectors: [],
        ...(tags.length || assets.length ? { library: { tags, assets } } : {}) };
      // The first UUID requested by this scoped action is the cut ID. All
      // other UUIDs still come from Chrome, and the API checks this same ID.
      const cutId = kind === 'cut' ? crypto.randomUUID() : null;
      const documents = cutId ? [{ ...document, cut: { cutId, sourceProjectId: projectId } }, document] : [document];
      const expected = documents.map(value => {
        const raw = JSON.stringify(value), index = nextFile++;
        const file = join(directory, 'expected-' + index + '.json');
        writeNativeExpected(file, projectId, raw, text, url);
        return { raw, file, owned: join(directory, 'own-' + index + '.json') };
      });
      if (!saved) {
        if (command('save', original) !== 'SAVED') throw new Error('系统剪贴板原值未保存');
        saved = true;
      }
      attempt = { url, text, remaining: [...expected], first: expected[0]!.raw, firstConfirmed: false, beforeWrite };
      await page.evaluate(({ cutId, url }) => {
        const scope = window as typeof window & {
          __forkwiseNativeCanvasWrite(phase: 'before' | 'after', raw?: number[], text?: number[]): Promise<void>;
          __forkwiseArmCanvasCut?: (id: typeof cutId) => void;
        };
        if (!document.hasFocus() || location.href !== url) throw new Error('合成项目失去剪贴板焦点');
        if (!scope.__forkwiseArmCanvasCut) {
          let nextCutId: typeof cutId = null;
          const uuid = crypto.randomUUID.bind(crypto);
          scope.__forkwiseArmCanvasCut = id => { nextCutId = id; };
          Object.defineProperty(crypto, 'randomUUID', { value: () => {
            const id = nextCutId;
            nextCutId = null;
            return id ?? uuid();
          }});
          const clipboard = navigator.clipboard, write = clipboard.write.bind(clipboard);
          Object.defineProperty(clipboard, 'writeText', { value: async () => { throw new Error('未声明的纯文本写入'); } });
          Object.defineProperty(clipboard, 'write', { value: async (items: ClipboardItem[]) => {
            const item = items[0], type = 'web application/x-forkwise-canvas';
            if (items.length !== 1 || !item || item.types.length !== 2 || !item.types.includes(type) || !item.types.includes('text/plain'))
              throw new Error('未声明的剪贴板写入格式');
            const bytes = async (format: string) => [...new Uint8Array(await (await item.getType(format)).arrayBuffer())];
            await scope.__forkwiseNativeCanvasWrite('before', await bytes(type), await bytes('text/plain'));
            try {
              if (!document.hasFocus() || location.href !== url) throw new Error('合成项目失去剪贴板焦点');
              await write(items);
            } finally { await scope.__forkwiseNativeCanvasWrite('after'); }
          }});
          // If the canvas key handler is unavailable, prevent default DOM
          // copy/cut from writing unrelated selected text into the pasteboard.
          window.addEventListener('copy', event => event.preventDefault(), true);
          window.addEventListener('cut', event => event.preventDefault(), true);
        }
        scope.__forkwiseArmCanvasCut(cutId);
      }, { cutId, url });
      await action();
      await expect.poll(() => !!attempt?.firstConfirmed || !!refusal).toBe(true);
      if (refusal) throw refusal;
      return expected[0]!.raw;
    }});
    if (refusal || armed) throw refusal ?? new Error('系统剪贴板写入尚未确认');
    return complete;
  } finally {
    closing = true;
    if (armed) await Promise.race([armed.done, wait(2000, undefined, { ref: false })]);
    closed = true;
    try {
      if (armed) throw new Error('已放行的系统剪贴板写入尚未有终态');
      if (saved && !unchanged(original)) {
        if (!lastOwned) throw new Error('系统剪贴板无本次确认写入，保留当前值');
        if (command('restore', original, lastOwned.owned) !== 'RESTORED') throw new Error('系统剪贴板恢复未确认');
      }
    } catch (cause) {
      // The original may be needed if Chrome wrote a format the guard could
      // not claim. Keep this owner-only directory for supervised recovery.
      throw new Error('系统剪贴板恢复需核对，已保留私有恢复目录：' + directory, { cause });
    }
    rmSync(directory, { recursive: true });
  }
}
