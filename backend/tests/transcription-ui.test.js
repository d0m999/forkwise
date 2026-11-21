import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { attachTranscription } from '../web/transcription.js';

const markup = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const original = { page: 1, verified: false };
const corrected = {
  page: 1,
  verified: true,
  impactAnalysis: {
    targetIds: ['sales', 'growth'],
    conditionIds: ['quarter'],
    jobIds: [],
    gap: '本机模型已停用，请对照校正后的文字复核相关引用。',
  },
};

function workbench() {
  const { document, Event } = parseHTML(markup);
  vi.stubGlobal('document', document);
  vi.stubGlobal(
    'Image',
    class {
      set src(_url) {
        this.onload();
      }
    },
  );
  const dialog = document.querySelector('#transcription-dialog');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => {
    dialog.removeAttribute('open');
    dialog.dispatchEvent(new Event('close'));
  };
  dialog.querySelector('canvas').getContext = () => ({
    drawImage() {},
    strokeRect() {},
    fillText() {},
  });
  const form = dialog.querySelector('form');
  form.reset = () => {};
  form.elements = {
    reason: form.querySelector('[name="reason"]'),
    confirmed: form.querySelector('[name="confirmed"]'),
  };
  const notice = document.querySelector('#notice');
  const state = {
    project: { id: 'project' },
    objects: [
      { kind: 'statement', id: 'sales', data: { text: '销量增加' } },
      { kind: 'inference', id: 'growth', data: { reason: '销量带动收入' } },
      { kind: 'condition', id: 'quarter', data: { description: '本季度销售达标' } },
      { kind: 'statement', id: 'unrelated', data: { text: '无关主张' } },
    ],
  };
  const artifacts = {
    original,
    corrected,
    legacy: { page: 1, verified: true },
    empty: {
      page: 1,
      verified: true,
      impactAnalysis: { targetIds: [], conditionIds: [], jobIds: [], gap: null },
    },
  };
  const api = async (path, method = 'GET') => {
    if (path === '/projects/project/transcription-corrections' && method === 'POST')
      return {
        sourceVersionId: 'corrected',
        artifact: corrected,
        impactAnalysis: corrected.impactAnalysis,
      };
    const match = path.match(/^\/projects\/project\/materials\/([^/]+)(\/anchors)?$/);
    if (method === 'GET' && match && artifacts[match[1]])
      return match[2] ? artifacts[match[1]] : { text: '销量 12' };
    throw new Error(`未预期的请求 ${method} ${path}`);
  };
  api.download = async () => new Blob();
  let pending;
  const open = attachTranscription({
    api,
    getState: () => state,
    jobs: async () => {},
    run: (fn) => (pending = fn()),
    message: (text) => (notice.textContent = text),
  });
  return {
    open: (id) => open({ id }),
    dialog,
    notice,
    state,
    async save() {
      form.elements.reason.value = '核对数字';
      form.elements.confirmed.checked = true;
      form.dispatchEvent(new Event('submit', { cancelable: true }));
      await pending;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

it('保存校正后列出引用该页的主张、推导关系与条件，并保留模型停用说明', async () => {
  const ui = workbench();
  await ui.open('original');
  await ui.save();
  expect(ui.dialog.hasAttribute('open')).toBe(false);
  const rows = [...ui.notice.querySelectorAll('li')].map((item) => item.textContent);
  expect(rows).toEqual([
    expect.stringMatching(/主张.*销量增加/),
    expect.stringMatching(/推导关系.*销量带动收入/),
    expect.stringMatching(/条件.*本季度销售达标/),
  ]);
  expect(ui.notice.textContent).toContain('本机模型已停用');
});

it('重开指定版本读取校正时的清单，对象已删除仍显示其身份；切换版本后显示对应记录', async () => {
  const ui = workbench();
  ui.state.objects = ui.state.objects.filter((object) => object.id !== 'growth');
  await ui.open('corrected');
  const rows = [...ui.dialog.querySelectorAll('li')].map((item) => item.textContent);
  expect(rows).toEqual([
    expect.stringMatching(/主张.*销量增加/),
    expect.stringMatching(/growth.*找不到/),
    expect.stringMatching(/条件.*本季度销售达标/),
  ]);
  expect(ui.dialog.textContent).toContain('本机模型已停用');
  ui.dialog.close();
  await ui.open('empty');
  expect(ui.dialog.querySelectorAll('li')).toHaveLength(0);
  expect(ui.dialog.textContent).toContain('校正时没有引用这页的研究对象');
  ui.dialog.close();
  await ui.open('legacy');
  expect(ui.dialog.textContent).toContain('此校正版本未保存复核清单，当时受影响的对象未知');
  expect(ui.dialog.textContent).not.toContain('校正时没有引用');
  ui.dialog.close();
  await ui.open('original');
  expect(ui.dialog.textContent).not.toContain('此校正版本');
  ui.dialog.close();
});
