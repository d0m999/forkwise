import { DOMParser } from 'linkedom';
import { requireThat } from '../domain/errors.js';
// Deliberately finite static subset. Original bytes remain immutable; rejected
// SVG is never attached to a browsing context or handed to a native decoder.
export function staticSvg(bytes: Buffer): { width: number; height: number } {
  const text = bytes.toString('utf8');
  requireThat(
    Buffer.from(text).equals(bytes) && !/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(text),
    'INVALID_SVG',
    'SVG编码或声明不受支持',
  );
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  requireThat(
    root?.localName === 'svg' && doc.querySelectorAll('svg').length === 1,
    'INVALID_SVG',
    'SVG根节点无效',
  );
  const tags = new Set([
    'svg',
    'g',
    'defs',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'title',
    'desc',
    'linearGradient',
    'radialGradient',
    'stop',
    'clipPath',
    'mask',
    'use',
  ]);
  const attrs = new Set([
    'xmlns',
    'xmlns:xlink',
    'id',
    'viewBox',
    'width',
    'height',
    'x',
    'y',
    'x1',
    'y1',
    'x2',
    'y2',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'd',
    'points',
    'fill',
    'fill-rule',
    'fill-opacity',
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-dasharray',
    'stroke-dashoffset',
    'opacity',
    'transform',
    'gradientTransform',
    'gradientUnits',
    'offset',
    'stop-color',
    'stop-opacity',
    'clip-path',
    'clip-rule',
    'mask',
    'font-size',
    'font-family',
    'font-weight',
    'text-anchor',
    'dominant-baseline',
    'preserveAspectRatio',
    'href',
    'xlink:href',
  ]);
  const nodes = [root, ...Array.from(root.querySelectorAll('*'))];
  requireThat(nodes.length <= 10000, 'INVALID_SVG', 'SVG节点过多');
  for (const node of nodes) {
    requireThat(
      tags.has(node.localName),
      'INVALID_SVG',
      '仅支持静态SVG：脚本、动效及嵌入内容不可用',
    );
    for (const attribute of Array.from(node.attributes) as { name: string; value: string }[]) {
      const { name, value } = attribute;
      requireThat(attrs.has(name), 'INVALID_SVG', 'SVG包含不支持的属性或事件');
      if (name === 'href' || name === 'xlink:href')
        requireThat(/^#[\w.-]+$/.test(value), 'INVALID_SVG', 'SVG不允许外部引用');
      if (name !== 'xmlns' && name !== 'xmlns:xlink')
        requireThat(
          !/(?:https?:|data:|file:|javascript:|\/\/|@import|\\)/i.test(value) &&
            !/url\(\s*(?!#[\w.-]+\s*\))/i.test(value),
          'INVALID_SVG',
          'SVG不允许外部资源',
        );
    }
  }
  const box = (root.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const dimension = (key: string, fallback: number | undefined) => {
    const value = root.getAttribute(key);
    return value === null
      ? fallback
      : /^\d+(?:\.\d+)?(?:px)?$/.test(value)
        ? Number(value.replace(/px$/, ''))
        : NaN;
  };
  const width = dimension('width', box.length === 4 ? box[2] : undefined),
    height = dimension('height', box.length === 4 ? box[3] : undefined);
  requireThat(
    typeof width === 'number' &&
      typeof height === 'number' &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0 &&
      width * height <= 40000000 &&
      width <= 40000000 &&
      height <= 40000000,
    'INVALID_IMAGE',
    'SVG尺寸无效或超过4000万像素',
  );
  return { width: Math.ceil(width), height: Math.ceil(height) };
}
