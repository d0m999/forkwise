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
type InlineStyle = Partial<Record<InlineMark['type'], true | string>>;
function inlineStyle(el: Element, inherited: InlineStyle): InlineStyle {
  const next = { ...inherited };
  const semantic: Record<string, InlineMark['type']> = {
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
  const type = semantic[el.tagName];
  if (type) next[type] = true;
  if (el.tagName === 'MARK') next.highlight = 'yellow';
  if (el.tagName === 'A') {
    const href = el.getAttribute('href') ?? '';
    if (safeLink(href)) next.link = href;
    else delete next.link;
  }
  const css = (el as HTMLElement).style;
  // Resolve only supported inline formats. Explicit resets/unsupported colors
  // clear the inherited mark instead of painting over the child's own choice.
  const set = (type: InlineMark['type'], declaration: string, value?: true | string) => {
    if (!declaration) return;
    if (declaration === 'inherit' || declaration === 'unset') value = inherited[type];
    if (value === undefined) delete next[type];
    else next[type] = value;
  };
  set('bold', css.fontWeight, /^(bold|[6-9]00)$/.test(css.fontWeight) ? true : undefined);
  set('italic', css.fontStyle, css.fontStyle === 'italic' ? true : undefined);
  const decoration = css.textDecorationLine || css.textDecoration;
  set('underline', decoration, decoration.includes('underline') ? true : undefined);
  set('strikethrough', decoration, decoration.includes('line-through') ? true : undefined);
  set('textColor', css.color, textPresets[css.color.replace(/\s/g, '')]);
  set('highlight', css.backgroundColor, highlightPresets[css.backgroundColor.replace(/\s/g, '')]);
  return next;
}
function inline(
  nodes: Node[],
  consumedLists: Element[] = [],
  inherited: InlineStyle = {},
): TableCell {
  let text = '';
  const marks: InlineMark[] = [];
  const append = (value: string, style: InlineStyle) => {
    if (!value) return;
    const start = text.length;
    text += value;
    for (const [type, value] of Object.entries(style) as [InlineMark['type'], true | string][]) {
      const previous = marks.findLast((m) => m.type === type);
      const markValue = typeof value === 'string' ? value : undefined;
      if (previous && previous.end === start && previous.value === markValue)
        previous.end = text.length;
      else
        marks.push({
          type,
          start,
          end: text.length,
          ...(markValue ? { value: markValue } : {}),
        });
    }
  };
  const children = (nodes: Node[], style: InlineStyle) => {
    let previousBlock = false,
      seen = false;
    for (const node of nodes) {
      const tag = node instanceof Element ? node.tagName : '';
      if (ignored.has(tag)) continue;
      if (tag === 'UL' || tag === 'OL') {
        if (!consumedLists.includes(node as Element))
          throw new Error('nested list requires complete plain-text fallback');
        continue;
      }
      const block = blockTags.has(tag);
      if (seen && (block || previousBlock)) text += '\n';
      visit(node, style);
      previousBlock = block;
      seen = true;
    }
  };
  const visit = (node: Node, inherited: InlineStyle) => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.textContent ?? '', inherited);
      return;
    }
    if (!(node instanceof Element) || ignored.has(node.tagName)) return;
    const style = inlineStyle(node, inherited);
    if (node.tagName === 'BR') {
      append('\n', style);
      return;
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') ?? '',
        alt = node.getAttribute('alt') ?? '';
      if (/^https?:/i.test(src) && safeLink(src))
        append((alt ? `图片链接：${alt} ` : '') + src, { ...style, link: src });
      else append(alt || '[图片尚未支持]', style);
      return;
    }
    children(Array.from(node.childNodes), style);
  };
  children(nodes, inherited);
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
  const paragraph = (nodes: Node[], shape: Partial<Block> = {}, inherited: InlineStyle = {}) => {
    const fragment = inert.createDocumentFragment();
    nodes.forEach((n) => fragment.append(n.cloneNode(true)));
    let split = false;
    for (const img of Array.from(fragment.querySelectorAll('img'))) {
      const image = embeddedImage(img.getAttribute('src') ?? '', img.getAttribute('alt') ?? '');
      if (!image) continue;
      const range = inert.createRange();
      range.selectNodeContents(fragment);
      range.setEndBefore(img);
      const before = inline(Array.from(range.cloneContents().childNodes), [], inherited);
      if (before.text) blocks.push({ ...identity(), type: 'text', ...shape, ...before });
      blocks.push(image);
      split = true;
      range.deleteContents();
      img.remove();
    }
    const after = inline(Array.from(fragment.childNodes), [], inherited);
    if (!split || after.text) blocks.push({ ...identity(), type: 'text', ...shape, ...after });
  };
  const list = (el: Element, parentId?: string, inherited: InlineStyle = {}) => {
    const style = inlineStyle(el, inherited);
    if (el.querySelector('img[src^="data:" i]'))
      throw new Error('image inside list requires fallback');
    for (const child of Array.from(el.children)) {
      if (child.tagName !== 'LI') throw new Error('unsupported list structure');
      const nestedLists = Array.from(child.children).filter((c) =>
        ['UL', 'OL'].includes(c.tagName),
      );
      const block: Block = {
        ...identity(),
        type: 'listItem',
        listType: el.tagName === 'OL' ? 'ordered' : 'bullet',
        ...(parentId ? { parentId } : {}),
        ...inline([child], nestedLists, style),
      };
      blocks.push(block);
      for (const nested of nestedLists) list(nested, block.id, inlineStyle(child, style));
    }
  };
  const visit = (parent: ParentNode, inherited: InlineStyle = {}) => {
    let pending: Node[] = [];
    const flush = () => {
      if (pending.some((n) => n.textContent?.trim() || n.nodeName === 'BR' || n.nodeName === 'IMG'))
        paragraph(pending, {}, inherited);
      pending = [];
    };
    for (const node of Array.from(parent.childNodes)) {
      if (!(node instanceof Element) || !blockTags.has(node.tagName)) {
        pending.push(node);
        continue;
      }
      flush();
      const tag = node.tagName;
      if (tag === 'UL' || tag === 'OL') list(node, undefined, inherited);
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
        if (caption) paragraph([caption], {}, inlineStyle(node, inherited));
        blocks.push({
          ...identity(),
          type: 'table',
          header: cells[0]!.every((c) => c.tagName === 'TH'),
          rows: cells.map((row) =>
            row.map((cell) => {
              const ancestors: Element[] = [];
              for (
                let parent = cell.parentElement;
                parent && parent !== node;
                parent = parent.parentElement
              )
                ancestors.unshift(parent);
              const style = ancestors.reduce(
                (style, el) => inlineStyle(el, style),
                inlineStyle(node, inherited),
              );
              return inline([cell], [], style);
            }),
          ),
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
        visit(node, inlineStyle(node, inherited));
      else
        paragraph(
          [node],
          /^H[1-3]$/.test(tag)
            ? { type: 'heading', level: Number(tag[1]) }
            : tag === 'BLOCKQUOTE'
              ? { type: 'quote' }
              : {},
          inherited,
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
