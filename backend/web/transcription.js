export function attachTranscription({ api, run, message, getState, jobs }) {
  const $ = (s) => document.querySelector(s),
    dialog = $('#transcription-dialog');
  let context = null,
    image = null,
    blobUrl = null,
    blocks = [];
  const redraw = () => {
    if (!image) return;
    const canvas = $('#transcription-image');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    blocks.forEach((block, i) => {
      const r = block.region;
      ctx.strokeStyle = block.uncertain ? '#b86114' : '#227463';
      ctx.lineWidth = Math.max(2, canvas.width / 500);
      ctx.strokeRect(
        r.x * canvas.width,
        r.y * canvas.height,
        r.width * canvas.width,
        r.height * canvas.height,
      );
      ctx.fillStyle = '#227463';
      ctx.font = `${Math.max(14, canvas.width / 65)}px sans-serif`;
      ctx.fillText(String(i + 1), r.x * canvas.width + 3, r.y * canvas.height + 20);
    });
  };
  function render() {
    const list = $('#transcription-blocks');
    list.replaceChildren();
    blocks.forEach((block, i) => {
      const row = document.createElement('div');
      row.className = 'transcription-block';
      const title = document.createElement('strong');
      title.textContent = `区域 ${i + 1}`;
      const text = document.createElement('textarea');
      text.value = block.text;
      text.required = true;
      text.setAttribute('aria-label', `区域 ${i + 1} 转写`);
      text.oninput = () => (block.text = text.value);
      const fields = document.createElement('div');
      fields.className = 'region-fields';
      for (const name of ['x', 'y', 'width', 'height']) {
        const label = document.createElement('label');
        label.textContent = name;
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.max = '1';
        input.step = '0.001';
        input.value = block.region[name];
        input.oninput = () => {
          block.region[name] = Number(input.value);
          redraw();
        };
        label.append(input);
        fields.append(label);
      }
      const uncertain = document.createElement('label'),
        check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = block.uncertain;
      check.onchange = () => {
        block.uncertain = check.checked;
        redraw();
      };
      uncertain.append(check, '仍有无法读清的内容');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '移除此转写区域';
      remove.onclick = () => {
        blocks.splice(i, 1);
        render();
        redraw();
      };
      row.append(title, text, fields, uncertain, remove);
      list.append(row);
    });
  }
  $('#close-transcription').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    image = null;
    blobUrl = null;
  });
  $('#add-transcription-block').onclick = () => {
    blocks.push({ text: '', region: { x: 0, y: 0, width: 1, height: 1 }, uncertain: false });
    render();
    redraw();
  };
  $('#transcription-form').onsubmit = (event) => {
    event.preventDefault();
    run(async () => {
      if (getState()?.project.id !== context.projectId)
        throw new Error('项目已切换，请回到原项目校正');
      const result = await api(
        `/projects/${context.projectId}/transcription-corrections`,
        'POST',
        {
          sourceVersionId: context.version.id,
          page: context.page,
          blocks,
          reason: event.target.elements.reason.value,
          confirmedAgainstImage: event.target.elements.confirmed.checked,
        },
        crypto.randomUUID(),
      );
      message(
        `人工校正已另存新版本；旧转写与证据保留。${result.impactAnalysis.jobIds.length ? `已排队 ${result.impactAnalysis.jobIds.length} 项影响分析，请在任务结果审阅候选。` : (result.impactAnalysis.gap ?? '当前没有引用这页的研究对象。')}${result.impactAnalysis.conditionIds.length ? '相关条件确认仍引用旧依据，须重新核对。' : ''}`,
      );
      dialog.close();
      await jobs();
    });
  };
  return async (version) => {
    const projectId = getState().project.id,
      artifact = await api(`/projects/${projectId}/materials/${version.id}/anchors`);
    const page =
      artifact.page ??
      Number(prompt(`输入需要核对的页码（共 ${artifact.pageCount ?? 1} 页）`, '1'));
    if (!Number.isInteger(page) || page < 1) return;
    const content = await api(`/projects/${projectId}/materials/${version.id}`);
    const blob = await api.download(
      `/projects/${projectId}/materials/${version.id}/image?page=${page}`,
    );
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(blob);
    image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('原图无法显示'));
      image.src = blobUrl;
    });
    context = { projectId, version, page };
    blocks = (artifact.regions ?? [])
      .filter((r) => r.page === page && r.region)
      .map((r) => ({
        text: content.text.slice(r.start, r.end),
        region: { ...r.region },
        uncertain: r.uncertain ?? false,
      }));
    if (!blocks.length)
      blocks = [
        {
          text: artifact.page ? content.text : '',
          region: { x: 0, y: 0, width: 1, height: 1 },
          uncertain: false,
        },
      ];
    $('#transcription-form').reset();
    render();
    redraw();
    $('#transcription-status').textContent =
      `第 ${page} 页 · ${artifact.verified ? '人工已核对版本' : '文字与定位仍需对照核对'}。区域坐标以左上角为原点，0–1 表示原图宽高比例。`;
    dialog.showModal();
  };
}
