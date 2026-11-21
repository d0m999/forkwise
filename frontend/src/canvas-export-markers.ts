export const EXPORT_PADDING = 32;
export const EXPORT_CONTENT_SELECTOR = '.react-flow__node, .canvas-frame, .canvas-frame-header, .canvas-group-outline, .canvas-connector, .connector-label';
// 哪些控件不进画布图像只在这里决定。附件文件名、卡片标题、分区名、连线文字和标签芯片不在此列。
// 导出规格只核对本轮样本里实际渲染出来的按钮。没画出来的按钮不会在这里失败。
const EXPORT_IGNORED_CONTROLS = [
  '.react-flow__controls', '.react-flow__attribution', '.react-flow__selection', '.react-flow__nodesselection-rect',
  '.card-actions', '.move-handle', '.body-button', '.card-resize', '.tag-overflow', '.text-actions', '.text-resize', '.canvas-frame-actions',
  '.frame-resize-overlay', '.canvas-group-tools', '.connector-endpoint', '.connector-entry', '.alignment-guide',
  '.image-crop', '.image-resize', '.shape-resize', '.canvas-gif-control', '.gif-toggle', '.shape-text-actions', '.shape-appearance-dialog',
  '.card-attachments button[aria-label^="解除 "]',
  '.card-attachments button[aria-label^="复制 "]',
  '.card-attachments button[aria-label="添加附件"]',
  '.card-attachments button[aria-label="收起附件"]',
  '.card-attachments button[aria-label^="还有 "]',
];
export const EXPORT_IGNORE_SELECTOR = EXPORT_IGNORED_CONTROLS.join(',');
export const EXPORT_CAPTURE_EVENT = 'forkwise-export-capture';
