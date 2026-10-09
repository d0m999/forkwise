import { parseHTML } from 'linkedom';
import { createHash } from 'node:crypto';
import { requireThat } from '../domain/errors.js';

export function parseHtml(html: string) {
  requireThat(
    html.length > 0 && html.length <= 5_000_000,
    'INVALID_HTML_SIZE',
    'HTML 内容须为 1 字符至 5 MB',
  );
  const { document } = parseHTML(html);
  const root = document.body.childNodes.length ? document.body : document.documentElement;
  requireThat(root, 'HTML_EMPTY', 'HTML 中没有可提取正文');
  let text = '';
  const blocks: { start: number; end: number; domPath: string; hash: string }[] = [];
  const walk = (node: Node, path: string) => {
    if (
      node.nodeType === 1 &&
      (node as Element).matches(
        'script,style,noscript,template,iframe,object,embed,form,[hidden],[aria-hidden="true"]',
      )
    )
      return;
    if (node.nodeType === 3) {
      const value = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!value) return;
      if (text) text += '\n';
      const start = text.length;
      text += value;
      blocks.push({
        start,
        end: text.length,
        domPath: path,
        hash: createHash('sha256').update(value).digest('hex'),
      });
      return;
    }
    [...node.childNodes].forEach((child, i) =>
      walk(child, `${path}/${child.nodeName.toLowerCase()}[${i}]`),
    );
  };
  walk(root, root.nodeName.toLowerCase());
  return {
    text,
    blocks,
    normalizerVersion: 'html-body@1',
    status: text ? 'complete' : 'partial',
    gaps: text ? [] : ['未提取到可读文本'],
    coverage: 'body_text',
  };
}
