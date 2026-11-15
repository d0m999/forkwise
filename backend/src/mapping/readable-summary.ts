import type { Block, ProjectState } from './contracts.js';
import { blockPlainText } from './body-text.js';
import type { ConnectorEndpoint } from './connector-contracts.js';

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readableBlock(block: Block): string {
  const text = blockPlainText(block).trim();
  if (block.type === 'image') {
    const label = oneLine(stringField(block.caption) ?? stringField(block.alt) ?? stringField(block.name) ?? stringField(block.assetId) ?? block.id);
    return `正文图片：${label}（${oneLine(stringField(block.name) ?? stringField(block.assetId) ?? block.id)}）`;
  }
  if (block.type === 'code') return text ? `代码（${oneLine(stringField(block.language) ?? '未标注')}）：\n${text}` : `代码（${oneLine(stringField(block.language) ?? '未标注')}）：（空代码块）`;
  if (text) return text;
  if (block.type === 'table') return '表格：（空表格）';
  if (['text', 'heading', 'listItem', 'quote'].includes(block.type)) return '';
  if (block.type === 'divider') return '---';
  return `未支持块 ${block.type}（${block.id}）：原始结构未展开`;
}

function itemLabel(state: ProjectState, itemId: string): string {
  const card = state.cards.find((value) => value.item.id === itemId);
  if (card) return `${oneLine(card.title) || '未命名卡片'}（${card.id}）`;
  const text = state.texts?.find((value) => value.item.id === itemId);
  if (text) return `${oneLine(text.content.runs.map((run) => run.text).join('')) || '独立文字'}（${text.id}/${itemId}）`;
  const shape = state.shapes?.find((value) => value.item.id === itemId);
  if (shape) return `${oneLine(shape.content.shortText) || shape.content.shapeType}（${shape.id}/${itemId}）`;
  const image = state.images?.find((value) => value.item.id === itemId);
  if (image) return `图片 ${image.id}（${itemId}）`;
  const stroke = state.strokes?.find((value) => value.item.id === itemId);
  if (stroke) return `笔迹 ${stroke.id}（${itemId}）`;
  const group = state.groups?.find((value) => value.itemId === itemId);
  if (group) return `组合（${group.id}）`;
  return `未知对象（${itemId}）`;
}

function endpointLabel(state: ProjectState, endpoint: ConnectorEndpoint): string {
  if (endpoint.kind === 'free') return `自由点（${endpoint.point.x}, ${endpoint.point.y}）`;
  if ((endpoint.targetKind ?? 'item') === 'frame') {
    const frame = state.frames?.find((value) => value.id === endpoint.itemId);
    return frame ? `${oneLine(frame.name)}（${frame.id}）` : `未知分区（${endpoint.itemId}）`;
  }
  return itemLabel(state, endpoint.itemId);
}

export function readableMarkdown(state: ProjectState, exportedAt: string): string {
  const tags = new Map((state.tags ?? []).map((tag) => [tag.id, tag.name]));
  const lines = [
    `# ${oneLine(state.project.name) || '未命名项目'}`,
    '',
    `项目 id：${state.project.id}`,
    `revision：${state.project.revision}`,
    `导出时间：${exportedAt}`,
    '',
    '> 这是可读摘要，不是完整恢复，也不是备份；它不是完整 JSON、画布图像或本机备份。',
    '',
    '## 卡片',
    '',
  ];
  for (const card of state.cards) {
    lines.push(`### ${oneLine(card.title) || '未命名卡片'}`, '', `卡片 id：${card.id}`, '');
    const cardTags = (card.cardTags?.tagIds ?? []).map((id) => tags.get(id) ?? `已删除标签（${id}）`);
    lines.push(`标签：${cardTags.length ? cardTags.map(oneLine).join('、') : '无'}`, '');
    lines.push(card.body.blocks.map(readableBlock).join('\n') || '（无正文）', '');
    const attachments = card.attachments?.items ?? [];
    lines.push(`卡片附件：${attachments.length ? attachments.map((item) => oneLine(item.name)).join('、') : '无'}`, '');
  }

  if (state.frames?.length) {
    lines.push('## 分区', '');
    const frames = new Map(state.frames.map((frame) => [frame.id, frame]));
    const visit = (id: string, depth: number, ancestors: ReadonlySet<string>) => {
      const frame = frames.get(id);
      if (!frame || ancestors.has(id)) {
        lines.push(`${'  '.repeat(depth)}- 无法解析的分区（${id}）`);
        return;
      }
      lines.push(`${'  '.repeat(depth)}- ${oneLine(frame.name)}（${frame.id}）`);
      const nextAncestors = new Set([...ancestors, id]);
      for (const child of state.frames!.filter((candidate) =>
        state.containment?.some((row) => row.id === candidate.id && row.parent?.kind === 'frame' && row.parent.id === id),
      )) visit(child.id, depth + 1, nextAncestors);
    };
    const roots = state.frames.filter((frame) => {
      const parent = state.containment?.find((row) => row.id === frame.id)?.parent;
      return parent?.kind !== 'frame';
    });
    for (const frame of roots) visit(frame.id, 0, new Set());
    lines.push('');
  }

  if (state.connectors?.length) {
    lines.push('## 普通连线', '');
    for (const connector of state.connectors) {
      const label = connector.label?.text ? `；标签：${oneLine(connector.label.text)}` : '；无标签';
      lines.push(`- ${endpointLabel(state, connector.start)} → ${endpointLabel(state, connector.end)}${label}（${connector.id}）`);
    }
    lines.push('', '普通连线由用户定义含义；几何和用户定义的含义不是证明、推导、证据或个人立场。', '');
  }

  if (state.attachments?.some((row) => row.target)) {
    lines.push('## 随动批注', '');
    for (const attachment of state.attachments.filter((row) => row.target)) {
      const target = state.cards.find((card) => card.item.id === attachment.target!.itemId);
      lines.push(`- ${itemLabel(state, attachment.id)} → ${target ? `${oneLine(target.title) || '未命名卡片'}（${target.id}）` : `未知卡片（${attachment.target!.itemId}）`}`);
    }
    lines.push('');
  }

  if (state.texts?.length || state.shapes?.length || state.images?.length || state.strokes?.length) {
    lines.push('## 独立对象', '');
    for (const text of state.texts ?? [])
      lines.push(`- 独立文字 ${text.id}：${text.content.runs.map((run) => run.text).join('') || '（无文字）'}（对象 ${text.item.id}）`);
    for (const shape of state.shapes ?? [])
      lines.push(`- 形状 ${shape.id}：${shape.content.shortText || shape.content.shapeType}（对象 ${shape.item.id}）`);
    for (const image of state.images ?? [])
      lines.push(`- 图片 ${image.id}：${image.content.assetId}（对象 ${image.item.id}；原件字节与裁剪结果不在此文件中展开）`);
    for (const stroke of state.strokes ?? [])
      lines.push(`- 笔迹 ${stroke.id}：${stroke.content.penKind}（对象 ${stroke.item.id}；路径不在此文件中展开）`);
    lines.push('');
  }

  if (state.groups?.length) {
    lines.push('## 组合', '');
    for (const group of state.groups)
      lines.push(`- 组合 ${group.id}：${group.memberItemIds.map((itemId) => itemLabel(state, itemId)).join('、')}`);
    lines.push('');
  }

  lines.push(
    '## 不能表达的结构与已知缺口',
    '',
    '- 画布几何、坐标、尺寸、遮挡顺序、图片裁剪与旋转不在此文件中恢复。',
    '- 笔迹路径、图片与卡片附件的原件字节不嵌入此文件；这里只保留可读文字、名称或索引。',
    '- 正文按可读文本写出，不保证完整富文本往返；行内样式、块属性、折叠状态和未知块结构不编造为等价 Markdown。',
    '- 未知块只保留类型与身份提示，原始块内容未在此文件中展开；既有原数据不因摘要被修改。',
    '- 普通连线的几何和用户定义的含义不是证明、推导、证据或个人立场。',
    '- 无权导出的原文不写入摘要，只保留既有来源索引与缺口。',
    '- 旧研究模型中的主张、推导、立场、条件和历史判断不在本文件中；它们仍保留在原项目数据中，本摘要未迁移或改写。',
    '',
  );
  return lines.join('\n');
}
