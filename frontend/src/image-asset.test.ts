import { expect, it } from 'vitest';
import { missingImageSizeMessage } from './api';

it('只有缺尺寸的读取错误会显示原提示，其他失败保持空白', () => {
  expect(missingImageSizeMessage(new Error('图片原件缺少尺寸'))).toBe('图片原件缺少尺寸');
  expect(missingImageSizeMessage(new Error('无法连接本机服务'))).toBeNull();
  expect(missingImageSizeMessage('图片原件缺少尺寸')).toBeNull();
});
