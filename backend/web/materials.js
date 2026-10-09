import { expectedVersions } from './operation-versions.js';
import { attachImageCitations } from './image-citations.js';
import { attachTranscription } from './transcription.js';
export function attachMaterials({
  api,
  run,
  message,
  getState,
  getSelected,
  getLayout,
  acceptChanges,
  write,
  jobs,
  textReader,
  submitFile,
}) {
  const $ = (s) => document.querySelector(s);
  const uid = () => crypto.randomUUID();
  const openTranscription = attachTranscription({ api, run, message, getState, jobs });
  const openImage = attachImageCitations({ api, run, getState, write, message });
  let focusedTarget = null;
  $('#upload-material').onsubmit = (event) => {
    event.preventDefault();
    run(async () => {
      const state = getState();
      if (!state) throw new Error('请先选择项目');
      const file = event.target.elements.file.files[0];
      if (!file || file.size > 25_000_000)
        throw new Error('请选择不超过 25 MB 的 PDF、HTML、PNG 或 JPEG');
      const mime =
        file.type ||
        {
          pdf: 'application/pdf',
          html: 'text/html',
          htm: 'text/html',
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
        }[file.name.split('.').at(-1).toLowerCase()];
      if (!['application/pdf', 'text/html', 'image/png', 'image/jpeg'].includes(mime))
        throw new Error('此入口暂不支持该文件格式');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let start = 0; start < bytes.length; start += 32768)
        binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
      const result = await submitFile(state.project.id, {
        source: { title: file.name, publisher: '', rights: 'authorized' },
        file: {
          name: file.name,
          mime,
          base64: btoa(binary),
          publishedAt: null,
        },
      });
      await acceptChanges(result.changes);
      message(`原文件已保存，解析任务 ${result.job.id} 已排队。解析进度与缺口会分别显示。`);
      await jobs();
      event.target.reset();
    });
  };
  const pendingKey = 'forkwise-pending-canvas-material';
  async function saveCanvas(pending) {
    try {
      const result = await api(
        `/projects/${pending.projectId}/canvas-materials`,
        'POST',
        pending.input,
        pending.key,
      );
      sessionStorage.removeItem(pendingKey);
      if (getState()?.project.id !== pending.projectId) return;
      await acceptChanges(result.changes);
      await list(pending.input.targetId);
      $('#list-materials').closest('details').open = true;
      message('原图已加入当前对象材料；画布图片和个人立场保持。');
    } catch (error) {
      if (error.code && error.code !== 'INTERNAL_ERROR') sessionStorage.removeItem(pendingKey);
      else {
        error.message = '图片加入材料的结果暂未确认；在材料列表中恢复同一操作。';
        $('#list-materials').closest('details').open = true;
        await list(pending.input.targetId);
      }
      throw error;
    }
  }
  async function list(targetId = null) {
    focusedTarget = targetId;
    const state = getState();
    if (!state) throw new Error('请先选择项目');
    const box = $('#material-list');
    box.replaceChildren();
    const pending = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
    if (pending?.projectId === state.project.id) {
      const recover = document.createElement('button');
      recover.textContent = '恢复图片加入材料操作';
      recover.onclick = () => run(() => saveCanvas(pending));
      box.append(recover);
    }

    const target = state.objects.find((e) => e.id === targetId);
    const heading = document.createElement('h3');
    heading.textContent = target
      ? `当前对象材料 · ${target.kind === 'statement' ? target.data.text : target.data.reason}`
      : '项目材料';
    box.append(heading);
    if (target) {
      const all = document.createElement('button');
      all.textContent = '从项目材料中复用';
      all.onclick = () => run(() => list());
      box.append(all);
    }

    for (const version of state.objects.filter((e) => e.kind === 'source_version')) {
      const membership = state.objects.find(
        (e) =>
          e.kind === 'material_membership' &&
          e.data.targetId === targetId &&
          e.data.sourceVersionId === version.id,
      );
      if (target && membership?.data.visibility !== 'included') continue;
      const source = state.objects.find((e) => e.id === version.data.sourceId);
      const item = document.createElement('div');
      const label = document.createElement('p');
      label.textContent = `${source?.data.title ?? '材料'} · ${version.data.parseStatus}${version.data.parseMessage ? ' · ' + version.data.parseMessage : ''}`;
      item.append(label);
      const chosen = targetId || getSelected();
      if (chosen) {
        const member = state.objects.find(
          (e) =>
            e.kind === 'material_membership' &&
            e.data.targetId === chosen &&
            e.data.sourceVersionId === version.id,
        );
        const button = document.createElement('button');
        button.textContent =
          member?.data.visibility === 'included' ? '从此对象材料列表移除' : '加入当前对象材料';
        button.onclick = () =>
          run(async () => {
            if (getState()?.project.id !== state.project.id)
              throw new Error('项目已切换，请重新打开材料');
            const commands = [
              member?.data.visibility === 'included'
                ? { op: 'material.hide', id: member.id }
                : {
                    op: 'material.attach',
                    id: member?.id ?? uid(),
                    targetId: chosen,
                    sourceVersionId: version.id,
                  },
            ];
            await write(commands, { expected: expectedVersions(state.objects, commands) });
            await list(focusedTarget);
          });
        item.append(button);
      }

      const read = document.createElement('button');
      read.textContent = '查看保存的文本';
      read.onclick = () => {
        if (getState()?.project.id === state.project.id) void textReader.open(version.id);
      };
      item.append(read);
      if (version.data.fileId) {
        const region = document.createElement('button');
        region.textContent = chosen ? '原图框选证据' : '查看原图区域';
        region.onclick = () => run(() => openImage(version, chosen));
        item.append(region);
        const compare = document.createElement('button');
        compare.textContent = '原图与转写校正';
        compare.onclick = () => run(() => openTranscription(version));
        item.append(compare);
        const ocr = document.createElement('button');
        ocr.textContent = '请求本页多模态识别';
        ocr.onclick = () =>
          run(async () => {
            const page = Number(prompt('输入原文件页码；截图填 1', '1'));
            if (!Number.isInteger(page) || page < 1) return;
            await api(
              `/projects/${state.project.id}/transcriptions`,
              'POST',
              { sourceVersionId: version.id, page },
              uid(),
            );
            message('已创建本页转写任务，结果与个人判断分开保存');
            await jobs();
          });
        item.append(ocr);
        const download = document.createElement('button');
        download.textContent = '下载原文件';
        download.onclick = () =>
          run(async () => {
            const blob = await api.download(
              `/projects/${state.project.id}/files/${version.data.fileId}`,
            );
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = source?.data.title ?? 'material';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          });
        item.append(download);
      }
      box.append(item);
    }
  }
  $('#list-materials').onclick = () => run(() => list());
  return {
    open: async (targetId) => {
      $('#list-materials').closest('details').open = true;
      await list(targetId);
    },
    readCitation: async (ref, targetId) => {
      const version = getState()?.objects.find((e) => e.id === (ref.sourceVersionId || ref.source));
      await openImage(version, targetId, ref);
    },
    canvas: async (action) => {
      const state = getState(),
        target = state?.objects.find((e) => e.id === action.id);
      if (!target) throw new Error('目标对象不存在');
      const previous = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
      if (
        previous &&
        (previous.projectId !== state.project.id ||
          previous.input.imageId !== action.imageId ||
          previous.input.targetId !== target.id)
      )
        throw new Error('还有未确认的图片材料操作，请先在原项目材料列表中恢复');
      const pending = previous ?? {
        projectId: state.project.id,
        key: uid(),
        input: {
          targetId: target.id,
          expectedTargetVersion: action.expectedTargetVersion ?? target.version,
          imageId: action.imageId,
          expectedLayoutVersion: getLayout().version,
        },
      };
      sessionStorage.setItem(pendingKey, JSON.stringify(pending));
      await saveCanvas(pending);
    },
  };
}
