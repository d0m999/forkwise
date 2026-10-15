import type { Block } from '../../backend/src/mapping/contracts';
import {
  safeLink,
  type InlineMark,
  type TableCell,
} from '../../backend/src/mapping/general-blocks';
import { plainTextBlocks } from './paste-selection';
import { embeddedImage } from './clipboard-images';
import { PENDING_IMAGE_MAX_BYTES } from '../../backend/src/mapping/pending-image';

const ignored = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'BASE', 'TITLE']);
// Exact existing editor presets only. Reading detached CSS declarations
// normalizes hex case and rgb spellings without mounting resource nodes.
const textPresets: Record<string, string> = {
  'rgb(105,115,134)': 'gray',
  'rgb(173,52,62)': 'red',
  'rgb(156,79,22)': 'orange',
  'rgb(38,115,77)': 'green',
  'rgb(36,87,173)': 'blue',
  'rgb(110,64,154)': 'purple',
};
const highlightPresets: Record<string, string> = {
  'rgb(255,240,181)': 'yellow',
  'rgb(220,238,226)': 'green',
  'rgb(222,235,255)': 'blue',
  'rgb(248,221,232)': 'pink',
};
const blockTags = new Set([
  'P',
  'DIV',
  'SECTION',
  'ARTICLE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'PRE',
  'UL',
  'OL',
  'TABLE',
  'HR',
]);
function htmlPlain(root: ParentNode): string {
  const visit = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element) || ignored.has(node.tagName)) return '';
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'IMG') return inline([node]).text;
    const text =
      node.tagName === 'TR'
        ? Array.from(node.children)
            .map((cell) => Array.from(cell.childNodes).map(visit).join(''))
            .join('\t')
        : Array.from(node.childNodes).map(visit).join('');
    return (['LI', 'TR'].includes(node.tagName) || blockTags.has(node.tagName)) &&
      !['UL', 'OL', 'TABLE'].includes(node.tagName) &&
      !text.endsWith('\n')
      ? text + '\n'
      : text;
  };
  return Array.from(root.childNodes).map(visit).join('').replace(/\n$/, '');
}
function inline(nodes: Node[]): TableCell {
  let text = '';
  const marks: InlineMark[] = [];
  const children = (nodes: Node[]) => {
    let previousBlock = false,
      seen = false;
    for (const node of nodes) {
      const tag = node instanceof Element ? node.tagName : '';
      if (ignored.has(tag) || tag === 'UL' || tag === 'OL') continue;
      const block = blockTags.has(tag);
      // Lists/quotes/cells have a single text field: preserve their paragraph
      // boundaries as literal line breaks, with marks measured after the break.
      if (seen && (block || previousBlock)) text += '\n';
      visit(node);
      previousBlock = block;
      seen = true;
    }
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement,
      tag = el.tagName;
    if (ignored.has(tag) || tag === 'UL' || tag === 'OL') return;
    if (tag === 'BR') {
      text += '\n';
      return;
    }
    const start = text.length;
    if (tag === 'IMG') {
      const src = el.getAttribute('src') ?? '',
        alt = el.getAttribute('alt') ?? '';
      if (/^https?:/i.test(src) && safeLink(src)) {
        text += (alt ? `图片链接：${alt} ` : '') + src;
        marks.push({ type: 'link', start, end: text.length, value: src });
      } else text += alt || '[图片尚未支持]';
      return;
    }
    children(Array.from(el.childNodes));
    if (text.length === start) return;
    const types: Record<string, InlineMark['type']> = {
      STRONG: 'bold',
      B: 'bold',
      EM: 'italic',
      I: 'italic',
      U: 'underline',
      S: 'strikethrough',
      STRIKE: 'strikethrough',
      DEL: 'strikethrough',
      CODE: 'code',
    };
    const add = (type: InlineMark['type'], value?: string) =>
      marks.push({
        type,
        start,
        end: text.length,
        ...(value ? { value } : {}),
      });
    if (types[tag]) add(types[tag]);
    if (tag === 'A' && safeLink(el.getAttribute('href') ?? ''))
      add('link', el.getAttribute('href')!);
    const style = el.getAttribute('style') ?? '';
    if (/(?:^|;)\s*font-weight\s*:\s*(?:bold|[6-9]00)\s*(?:;|$)/i.test(style)) add('bold');
    if (/(?:^|;)\s*font-style\s*:\s*italic\s*(?:;|$)/i.test(style)) add('italic');
    if (/(?:^|;)\s*text-decoration(?:-line)?\s*:[^;]*underline/i.test(style)) add('underline');
    if (/(?:^|;)\s*text-decoration(?:-line)?\s*:[^;]*line-through/i.test(style))
      add('strikethrough');
    const color = textPresets[el.style.color.replace(/\s/g, '')];
    const highlight = highlightPresets[el.style.backgroundColor.replace(/\s/g, '')];
    if (color) add('textColor', color);
    if (highlight || tag === 'MARK') add('highlight', highlight ?? 'yellow');
  };
  children(nodes);
  return { text, ...(marks.length ? { marks } : {}) };
}

export function htmlBlocks(html: string, plain: string): { blocks: Block[]; notice?: string } {
  // No browsing context and inert template content: resource-bearing elements
  // are never attached to the live document, even before filtering.
  const inert = document.implementation.createHTMLDocument('');
  const template = inert.createElement('template');
  template.innerHTML = html;
  const root = template.content;
  root.querySelectorAll('script,style,link,meta,base,title').forEach((n) => n.remove());
  const images = Array.from(root.querySelectorAll('img')).flatMap((img) => {
    const block = embeddedImage(img.getAttribute('src') ?? '', img.getAttribute('alt') ?? '');
    return block ? [block] : [];
  });
  if (
    images.reduce((size, block) => size + (block.byteLength as number), 0) > PENDING_IMAGE_MAX_BYTES
  )
    throw new Error('内嵌图片超过本次暂存上限，原剪贴板与正文均保留');
  const fallback = () => ({
    blocks: [...plainTextBlocks(plain || htmlPlain(root)), ...images],
    notice: '无法可靠保留此内容的结构，已保留纯文本原文与已有图片字节',
  });
  if (root.querySelector('iframe,object,embed,form,svg,math,canvas,video,audio,template'))
    return fallback();
  const blocks: Block[] = [];
  const identity = () => ({
    id: crypto.randomUUID(),
    inlineId: crypto.randomUUID(),
  });
  const paragraph = (nodes: Node[], shape: Partial<Block> = {}) => {
    const fragment = inert.createDocumentFragment();
    nodes.forEach((n) => fragment.append(n.cloneNode(true)));
    let split = false;
    for (const img of Array.from(fragment.querySelectorAll('img'))) {
      const image = embeddedImage(img.getAttribute('src') ?? '', img.getAttribute('alt') ?? '');
      if (!image) continue;
      const range = inert.createRange();
      range.selectNodeContents(fragment);
      range.setEndBefore(img);
      const before = inline(Array.from(range.cloneContents().childNodes));
      if (before.text) blocks.push({ ...identity(), type: 'text', ...shape, ...before });
      blocks.push(image);
      split = true;
      range.deleteContents();
      img.remove();
    }
    const after = inline(Array.from(fragment.childNodes));
    if (!split || after.text) blocks.push({ ...identity(), type: 'text', ...shape, ...after });
  };
  const list = (el: Element, parentId?: string) => {
    if (el.querySelector('img[src^="data:" i]'))
      throw new Error('image inside list requires fallback');
    for (const child of Array.from(el.children)) {
      if (child.tagName !== 'LI') throw new Error('unsupported list structure');
      const block: Block = {
        ...identity(),
        type: 'listItem',
        listType: el.tagName === 'OL' ? 'ordered' : 'bullet',
        ...(parentId ? { parentId } : {}),
        ...inline([child]),
      };
      blocks.push(block);
      for (const nested of Array.from(child.children).filter((c) =>
        ['UL', 'OL'].includes(c.tagName),
      ))
        list(nested, block.id);
    }
  };
  const visit = (parent: ParentNode) => {
    let pending: Node[] = [];
    const flush = () => {
      if (pending.some((n) => n.textContent?.trim() || n.nodeName === 'BR' || n.nodeName === 'IMG'))
        paragraph(pending);
      pending = [];
    };
    for (const node of Array.from(parent.childNodes)) {
      if (!(node instanceof Element) || !blockTags.has(node.tagName)) {
        pending.push(node);
        continue;
      }
      flush();
      const tag = node.tagName;
      if (tag === 'UL' || tag === 'OL') list(node);
      else if (tag === 'TABLE') {
        if (node.querySelector('img[src^="data:" i]'))
          throw new Error('image inside table requires fallback');
        if (node.querySelector('table,[colspan]:not([colspan="1"]),[rowspan]:not([rowspan="1"])'))
          throw new Error('unsupported table structure');
        const rows = Array.from(node.querySelectorAll('tr'));
        const cells = rows.map((row) =>
          Array.from(row.children).filter((c) => ['TD', 'TH'].includes(c.tagName)),
        );
        if (
          !cells.length ||
          !cells[0]!.length ||
          cells.some((row) => row.length !== cells[0]!.length)
        )
          throw new Error('unsupported table shape');
        const caption = node.querySelector('caption');
        if (caption) paragraph(Array.from(caption.childNodes));
        blocks.push({
          ...identity(),
          type: 'table',
          header: cells[0]!.every((c) => c.tagName === 'TH'),
          rows: cells.map((row) => row.map((cell) => inline([cell]))),
        });
      } else if (tag === 'PRE')
        blocks.push({
          ...identity(),
          type: 'code',
          text: node.textContent ?? '',
          language: '',
          wrap: false,
        });
      else if (tag === 'HR') blocks.push({ ...identity(), type: 'divider' });
      else if (
        ['DIV', 'SECTION', 'ARTICLE'].includes(tag) &&
        Array.from(node.children).some((c) => blockTags.has(c.tagName))
      )
        visit(node);
      else
        paragraph(
          [node],
          /^H[1-3]$/.test(tag)
            ? { type: 'heading', level: Number(tag[1]) }
            : tag === 'BLOCKQUOTE'
              ? { type: 'quote' }
              : {},
        );
    }
    flush();
  };
  try {
    visit(root);
  } catch {
    return fallback();
  }
  return blocks.length ? { blocks } : fallback();
}
