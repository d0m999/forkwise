// Shared engineering defaults for the current plain-text card slice. Rendering
// colors come from authority; visual tokens are defined in frontend/src/style.css.
export const TITLE_COLORS = {
  默认蓝: '#edf1fa',
  杏色: '#f7e9bd',
  绿色: '#dceee2',
  玫瑰色: '#f3dfe5',
  淡紫色: '#e8e1f5',
  白色: '#ffffff',
} as const;
export const DEFAULT_APPEARANCE = { titleColor: TITLE_COLORS.默认蓝, showPreview: true } as const;
export const DEFAULT_PREVIEW_HEIGHT = 160;
