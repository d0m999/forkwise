import type { ComponentPropsWithRef } from 'react';

// Outlines from the R2 prototype. See its vendor/LICENSE-lucide.txt.
const icons = {
  选择: <path d="m4 3 7.07 17 2.51-6.42L20 11.07 4 3Z" />,
  移动: <path d="M18 11V7a2 2 0 0 0-4 0v4M14 10V5a2 2 0 0 0-4 0v6M10 10.5V7a2 2 0 0 0-4 0v9a6 6 0 0 0 6 6h2a6 6 0 0 0 6-6v-3a2 2 0 0 0-4 0" />,
  卡片: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18m-12 6h6m-3-3v6" /></>,
  文字: <path d="M4 7V4h16v3M9 20h6M12 4v16" />,
  形状: <rect x="4" y="4" width="16" height="16" rx="2" />,
  连线: <path d="M4 20 20 4m-9 0h9v9" />,
  画笔: <path d="m16 3 5 5L8 21H3v-5L16 3Zm-2 2 5 5" />,
  图片: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>,
  分区: <path d="M4 2v20M20 2v20M2 4h20M2 20h20" />,
  对齐吸附: <><path d="M6 3v18m12-18v18M1 8h3m-3 8h3m16-8h3m-3 8h3" /><rect x="9" y="8" width="6" height="8" rx="1" /></>,
  撤销: <path d="M3 7h11a7 7 0 0 1 0 14M3 7l6-6M3 7l6 6" />,
  重做: <path d="M21 7H10a7 7 0 0 0 0 14M21 7l-6-6M21 7l-6 6" />,
  复制: <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
};

type ToolButtonProps = ComponentPropsWithRef<'button'> & {
  label: keyof typeof icons;
  hint?: string;
};

export function CanvasToolButton({ label, hint = label, children, ...props }: ToolButtonProps) {
  return (
    <button type="button" className="canvas-tool-button" aria-label={label} {...props}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {icons[label]}
      </svg>
      {children}
      <span role="tooltip" className="canvas-tool-hint">{hint}</span>
    </button>
  );
}
