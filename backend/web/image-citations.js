import { expectedVersions } from './operation-versions.js';
const uid = () => crypto.randomUUID();
const relations = {
  unjudged: '暂不判断',
  supports: '支持',
  opposes: '反对',
  qualifies: '限定',
  background: '背景',
};
export function attachImageCitations({ api, run, getState, write, message }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'image-citation-dialog';
  dialog.setAttribute('aria-label', '原图区域证据');
  dialog.innerHTML =
    '<header><h2>原图区域证据</h2><button type="button" data-close>关闭</button></header><p data-description></p><p data-feedback role="status"></p><canvas aria-label="拖动选择原图证据区域"></canvas><form><fieldset><legend>区域坐标（原图比例，可拖动框选）</legend><div class="region-fields"></div></fieldset><label>与当前对象的关系<select name="relation"></select></label><label>说明<textarea name="explanation" placeholder="可以先保留区域，稍后判断关系"></textarea></label><button type="submit">保存区域证据</button></form><div data-links></div>';
  document.body.append(dialog);
  const $ = (s) => dialog.querySelector(s),
    form = $('form'),
    canvas = $('canvas'),
    feedback = $('[data-feedback]');
  let context = null,
    image = null,
    region = null,
    url = null,
    start = null;
  for (const [value, title] of Object.entries(relations)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = title;
    form.elements.relation.append(option);
  }
  for (const [name, title] of Object.entries({
    x: '左侧',
    y: '顶部',
    width: '宽度',
    height: '高度',
  })) {
    const label = document.createElement('label'),
      input = document.createElement('input');
    label.textContent = title;
    input.type = 'number';
    input.name = name;
    input.min = '0';
    input.max = '1';
    input.step = 'any';
    input.required = true;
    input.oninput = () => {
      region = Object.fromEntries(
        ['x', 'y', 'width', 'height'].map((n) => [n, Number(form.elements[n].value)]),
      );
      draw();
    };
    label.append(input);
    $('.region-fields').append(label);
  }
  const setRegion = (r) => {
    region = r;
    for (const n of ['x', 'y', 'width', 'height']) form.elements[n].value = Number(r[n].toFixed(6));
    draw();
  };
  function draw() {
    if (!image) return;
    const ctx = canvas.getContext('2d');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    ctx.drawImage(image, 0, 0);
    if (region) {
      ctx.strokeStyle = '#b53e25';
      ctx.lineWidth = Math.max(2, canvas.width / 250);
      ctx.strokeRect(
        region.x * canvas.width,
        region.y * canvas.height,
        region.width * canvas.width,
        region.height * canvas.height,
      );
    }
  }
  const point = (e) => {
    const b = canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)),
      y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)),
    };
  };
  canvas.onpointerdown = (e) => {
    if (form.hidden) return;
    start = point(e);
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    if (!start) return;
    const end = point(e);
    setRegion({
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(start.x - end.x),
      height: Math.abs(start.y - end.y),
    });
  };
  canvas.onpointerup = () => {
    start = null;
  };
  canvas.onpointercancel = () => {
    start = null;
  };
  $('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    if (url) URL.revokeObjectURL(url);
    url = null;
    context = null;
    image = null;
    start = null;
  });
  const perform = (fn) =>
    run(async () => {
      try {
        await fn();
      } catch (error) {
        feedback.textContent = sessionStorage.getItem('forkwise-pending')
          ? `${error.message}。保存结果尚未确认，请关闭窗口后使用“恢复上次操作”。`
          : error.message;
      }
    });
  function assertProject() {
    if (!context || getState()?.project.id !== context.projectId)
      throw new Error('项目已切换，请重新打开材料');
  }
  function listLinks() {
    const box = $('[data-links]');
    box.replaceChildren();
    if (!context?.target) return;
    const state = getState(),
      target = state.objects.find((e) => e.id === context.target.id);
    const endpoints =
      target?.kind === 'inference'
        ? [...new Set([...target.data.premiseIds, target.data.conclusionId])].sort().map((id) => ({
            id,
            versionId: state.objects.find((e) => e.id === id)?.contentVersionId,
          }))
        : [];
    for (const link of state.objects.filter(
      (e) => e.kind === 'evidence_link' && e.data.target.id === context.target.id,
    )) {
      const evidence = state.objects.find((e) => e.id === link.data.evidenceId),
        c = evidence?.data.citation;
      if (c?.kind !== 'image' || c.sourceVersionId !== context.version.id) continue;
      const current =
        link.data.target.versionId === target?.contentVersionId &&
        JSON.stringify(link.data.context ?? []) === JSON.stringify(endpoints);
      const row = document.createElement('div'),
        read = document.createElement('button'),
        remove = document.createElement('button');
      read.textContent = `${relations[link.data.relation]} · ${current ? '当前内容' : '旧内容或前提，须重新核对'}`;
      read.onclick = () => {
        setRegion(c.region);
        form.elements.relation.value = link.data.relation;
        form.elements.explanation.value = link.data.explanation;
        feedback.textContent = current
          ? '可更改关系后保存'
          : '旧关联保持；重新保存将按打开窗口时的内容版本建立新关联';
      };
      remove.textContent = '解除此关联';
      remove.onclick = () =>
        perform(async () => {
          assertProject();
          await write([{ op: 'object.delete', id: link.id }], {
            expected: expectedVersions(state.objects, [{ op: 'object.delete', id: link.id }]),
          });
          listLinks();
          feedback.textContent = '已解除关联；原材料与证据保留';
        });
      row.append(read, remove);
      box.append(row);
    }
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    perform(async () => {
      assertProject();
      if (
        !region ||
        !Object.values(region).every(Number.isFinite) ||
        region.x < 0 ||
        region.y < 0 ||
        region.width <= 0 ||
        region.height <= 0 ||
        region.x + region.width > 1.000001 ||
        region.y + region.height > 1.000001
      )
        throw new Error('请选择原图以内的有效区域');
      const { target, version, objects } = context;
      const citation = {
        kind: 'image',
        sourceVersionId: version.id,
        fileId: version.data.fileId,
        page: 1,
        imageWidth: image.naturalWidth,
        imageHeight: image.naturalHeight,
        region: { ...region },
      };
      const current = getState().objects;
      const same = (c) =>
        c?.kind === 'image' &&
        c.sourceVersionId === citation.sourceVersionId &&
        c.fileId === citation.fileId &&
        c.imageWidth === citation.imageWidth &&
        c.imageHeight === citation.imageHeight &&
        ['x', 'y', 'width', 'height'].every((n) => c.region[n] === region[n]);
      const existing = current.find((e) => e.kind === 'evidence' && same(e.data.citation)),
        evidenceId = existing?.id ?? uid();
      const refs =
        target.kind === 'inference'
          ? [...new Set([...target.data.premiseIds, target.data.conclusionId])]
              .sort()
              .map((id) => ({ id, versionId: objects.find((e) => e.id === id).contentVersionId }))
          : [];
      const link = current.find(
        (e) =>
          e.kind === 'evidence_link' &&
          e.data.evidenceId === evidenceId &&
          e.data.target.id === target.id &&
          e.data.target.versionId === target.contentVersionId &&
          JSON.stringify(e.data.context ?? []) === JSON.stringify(refs),
      );
      const explanation =
        form.elements.explanation.value.trim() || '保留原图区域，尚未补充判断说明';
      const commands = [
        ...(!existing ? [{ op: 'evidence.create', id: evidenceId, data: { citation } }] : []),
        link
          ? {
              op: 'evidence.relate',
              id: link.id,
              relation: form.elements.relation.value,
              explanation,
            }
          : {
              op: 'evidence.link',
              id: uid(),
              data: {
                evidenceId,
                target: { id: target.id, versionId: target.contentVersionId },
                context: refs,
                relation: form.elements.relation.value,
                explanation,
                origin: 'human',
                participation: 'adopted',
              },
            },
      ];
      // Preserve target/endpoint versions captured when the image was opened.
      const base = current.map((e) => objects.find((old) => old.id === e.id) ?? e);
      await write(commands, { expected: expectedVersions(base, commands) });
      // Retain the research context; refresh only relation identities for repeat edits.
      context.objects = context.objects
        .filter((e) => !['evidence', 'evidence_link'].includes(e.kind))
        .concat(getState().objects.filter((e) => ['evidence', 'evidence_link'].includes(e.kind)));
      feedback.textContent = '区域证据已保存；个人立场保持。';
      message(feedback.textContent);
      listLinks();
    });
  };
  return async function open(version, targetId, citation) {
    const state = getState();
    if (!state) throw new Error('请先选择项目');
    if (dialog.open) dialog.close();
    context = {
      projectId: state.project.id,
      version,
      target: state.objects.find((e) => e.id === targetId),
      objects: structuredClone(state.objects),
    };
    const targetText =
      context.target?.kind === 'statement' ? context.target.data.text : context.target?.data.reason;
    $('h2').textContent = targetText ? `原图区域证据 · ${targetText.slice(0, 28)}` : '原图区域证据';
    form.hidden = !context.target;
    feedback.textContent = '正在读取原图…';
    $('[data-links]').replaceChildren();
    dialog.showModal();
    try {
      if (!version?.data.fileId) throw new Error('此材料没有原图');
      const original = await api.download(
        `/projects/${state.project.id}/files/${version.data.fileId}`,
      );
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(original.type))
        throw new Error('此入口用于图片原文件；PDF 请使用页图与转写入口');
      const blob = await api.download(
        `/projects/${state.project.id}/materials/${version.id}/image`,
      );
      if (!dialog.open || context?.version.id !== version.id) return;
      url = URL.createObjectURL(blob);
      image = new Image();
      image.src = url;
      await image.decode();
      if (!dialog.open) return;
      form.reset();
      setRegion(citation?.region ?? { x: 0, y: 0, width: 1, height: 1 });
      $('[data-description]').textContent =
        `原图 ${image.naturalWidth} × ${image.naturalHeight} 像素。按第一帧定位；选择区域不代表认可其中观点。`;
      feedback.textContent = citation?.unavailableReason
        ? '该引用曾标记为不可复核，请对照原文件重新核对。'
        : '';
      listLinks();
    } catch (error) {
      feedback.textContent = error.message;
      form.hidden = true;
    }
  };
}
