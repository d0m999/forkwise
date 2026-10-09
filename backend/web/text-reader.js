const scopeLabels = {
  full: '保存范围标注为全文；此标注不证明外部材料完整性。',
  excerpt: '当前保存的是摘录，不能在此查阅完整原文。',
  unknown: '保存范围尚未说明，当前只展示这一版本实际保存的文本。',
};
const boundary = (text, at, direction) =>
  at > 0 &&
  at < text.length &&
  /^[\uDC00-\uDFFF]$/.test(text[at]) &&
  /^[\uD800-\uDBFF]$/.test(text[at - 1])
    ? at + direction
    : at;
const externalUrl = (value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
};

/** Read only: every open resolves one immutable material version and checks its stored fingerprint. */
export function attachTextReader({ api, getState }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'text-reader-dialog';
  dialog.setAttribute('aria-label', '材料原文阅读');
  dialog.innerHTML =
    '<header><h2>材料原文阅读</h2><div><button data-enlarge>放大阅读</button><button data-return>返回来源</button><button data-close>返回画布</button></div></header><h3 data-title></h3><p data-scope></p><p data-metadata></p><p data-origin></p><p data-feedback role="status"></p><blockquote data-quote hidden></blockquote><nav><button data-previous>上一段</button><button data-anchor>回到引用</button><button data-next>下一段</button></nav><p data-range></p><pre id="material-content" data-text tabindex="0"></pre><a data-external target="_blank" rel="noopener noreferrer" hidden>打开原始网页</a><p data-external-note hidden>原始网页可能已更新，不代替当前保存版本。</p>';
  document.body.append(dialog);
  const $ = (s) => dialog.querySelector(s),
    pageSize = 12000;
  let generation = 0,
    context = null;
  const close = () => dialog.close();
  $('[data-close]').onclick = close;
  dialog.addEventListener('close', () => {
    generation++;
    context = null;
  });
  $('[data-enlarge]').onclick = () => {
    const expanded = dialog.classList.toggle('expanded');
    $('[data-enlarge]').textContent = expanded ? '还原大小' : '放大阅读';
  };
  $('[data-return]').onclick = () => {
    const saved = context;
    close();
    if (saved && getState()?.project.id === saved.projectId) saved.returnSource?.();
  };
  function render(start, focus = false) {
    if (!context || context.text === null) return;
    const { text, citation } = context;
    start = boundary(text, Math.max(0, Math.min(start, Math.max(0, text.length - pageSize))), -1);
    const end = boundary(text, Math.min(text.length, start + pageSize), 1);
    context.start = start;
    context.end = end;
    const pre = $('[data-text]');
    pre.replaceChildren();
    if (citation && citation.start < end && citation.end > start) {
      const left = Math.max(start, citation.start),
        right = Math.min(end, citation.end),
        mark = document.createElement('mark');
      mark.textContent = text.slice(left, right);
      pre.append(
        document.createTextNode(text.slice(start, left)),
        mark,
        document.createTextNode(text.slice(right, end)),
      );
    } else pre.textContent = text.slice(start, end);
    $('[data-range]').textContent = text.length
      ? `显示保存文本第 ${start + 1}–${end} 位，共 ${text.length} 位。${citation ? '引用位置 ' + (citation.start + 1) + '–' + citation.end + '。' : ''}`
      : '此版本没有可读文本，请查看原文件和解析缺口。';
    $('[data-previous]').hidden = start === 0;
    $('[data-next]').hidden = end === text.length;
    $('[data-anchor]').hidden = !citation;
    if (focus) {
      pre.focus({ preventScroll: true });
      const mark = pre.querySelector('mark');
      pre.scrollTop = mark ? Math.max(0, mark.offsetTop - pre.clientHeight / 2) : 0;
      dialog.scrollTop = 0;
    }
  }
  const anchor = () => {
    if (context) render(context.citation ? Math.max(0, context.citation.start - 2000) : 0, true);
  };
  $('[data-previous]').onclick = () => {
    if (context) render(context.start - pageSize, true);
  };
  $('[data-next]').onclick = () => {
    if (context) render(context.end, true);
  };
  $('[data-anchor]').onclick = anchor;
  async function open(ref, options = {}) {
    const token = ++generation,
      state = getState(),
      projectId = state?.project.id;
    const versionId = typeof ref === 'string' ? ref : (ref.sourceVersionId ?? ref.source);
    const version = state?.objects.find((e) => e.id === versionId && e.kind === 'source_version');
    const source = state?.objects.find(
      (e) => e.id === version?.data.sourceId && e.kind === 'source',
    );
    const citation =
      typeof ref === 'string' ? null : { start: ref.start, end: ref.end, quote: ref.quote };
    context = {
      projectId,
      versionId,
      citation,
      text: null,
      start: 0,
      end: 0,
      returnSource: options.returnSource,
    };
    dialog.dataset.version = versionId ?? '';
    dialog.classList.remove('expanded');
    $('[data-enlarge]').textContent = '放大阅读';
    $('[data-return]').hidden = !options.returnSource;
    $('[data-title]').textContent = source?.data.title ?? '材料版本不可用';
    $('[data-scope]').textContent = scopeLabels[version?.data.coverage ?? 'unknown'];
    $('[data-metadata]').textContent = version
      ? `${source?.data.publisher ? '发布者：' + source.data.publisher + '；' : ''}发布时间：${version.data.publishedAt ?? '未记录'}；获取时间：${version.data.retrievedAt}。${version.data.businessPeriod ? '业务期间：' + version.data.businessPeriod.start + ' 至 ' + version.data.businessPeriod.end + '。' : ''}`
      : '';
    $('[data-origin]').textContent = version
      ? `${version.data.textOrigin === 'ocr' ? '识别文本，尚未逐字核对。' : version.data.textOrigin === 'human_correction' ? '人工校正文本；原文件保持。' : ''}${version.data.parseMessage || ''}`
      : '';
    const url = externalUrl(source?.data.url);
    $('[data-external]').hidden = !url;
    $('[data-external-note]').hidden = !url;
    if (url) $('[data-external]').href = url;
    else $('[data-external]').removeAttribute('href');
    $('[data-text]').replaceChildren();
    $('[data-range]').textContent = '';
    $('nav').hidden = true;
    $('[data-quote]').hidden = !citation;
    $('[data-quote]').textContent = citation?.quote ?? '';
    $('[data-feedback]').textContent = '正在读取引用对应的保存版本…';
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    try {
      if (!projectId || !version) throw new Error('材料版本不存在，未改读其他版本。');
      if (typeof ref !== 'string' && ref.unavailableReason)
        throw new Error(
          ref.unavailableReason === 'rights'
            ? '原文受权限限制，此副本不含可复核文本。'
            : '此副本缺少引用原文。',
        );
      const material = await api(
        `/projects/${encodeURIComponent(projectId)}/materials/${encodeURIComponent(versionId)}`,
      );
      const bytes = new TextEncoder().encode(material.text);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      if (token !== generation || !dialog.open || getState()?.project.id !== projectId) return;
      if (
        material.id !== versionId ||
        typeof material.text !== 'string' ||
        material.text.length !== version.data.textLength ||
        hash !== version.data.contentHash
      )
        throw new Error('材料内容与保存的指纹不符，无法复核此引用。');
      if (
        citation &&
        (!Number.isInteger(citation.start) ||
          !Number.isInteger(citation.end) ||
          citation.start < 0 ||
          citation.end <= citation.start ||
          citation.end > material.text.length ||
          typeof citation.quote !== 'string' ||
          material.text.slice(citation.start, citation.end) !== citation.quote ||
          boundary(material.text, citation.start, -1) !== citation.start ||
          boundary(material.text, citation.end, 1) !== citation.end)
      )
        throw new Error('引用位置与原句不符，未自动改用其他位置或版本。');
      context.text = material.text;
      $('[data-feedback]').textContent = citation
        ? '已定位保存原句。阅读与高亮不表示采用或认可。'
        : '当前仅阅读已保存文本，不改变研究判断。';
      $('[data-quote]').hidden = true;
      $('nav').hidden = false;
      anchor();
    } catch (error) {
      if (token !== generation || !dialog.open) return;
      $('[data-feedback]').textContent = `无法复核：${error.message}`;
    }
  }
  return { open };
}
