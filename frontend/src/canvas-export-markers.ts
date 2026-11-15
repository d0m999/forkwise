export const exportIgnoreProps = { 'data-export-ignore': '' } as const;
export const EXPORT_PADDING = 32;
export const EXPORT_CONTENT_SELECTOR = '.react-flow__node, .canvas-frame, .canvas-frame-header, .canvas-group-outline, .canvas-connector, .connector-label';
// React Flow 自己绘制控件和选区，组件上加不上标记；自有交互控件用 data-export-ignore。
export const EXPORT_IGNORE_SELECTOR = '[data-export-ignore], .react-flow__controls, .react-flow__attribution, .react-flow__selection, .react-flow__nodesselection-rect';
export const EXPORT_CAPTURE_EVENT = 'forkwise-export-capture';
