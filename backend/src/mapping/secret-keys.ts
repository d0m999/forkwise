// 会话与凭证类键不进入导出包：导出脱敏与包级校验共用这一份键集，避免两处漂移后校验静默放行。
export const SECRET_KEYS = new Set([
  'session',
  'token',
  'tokenHash',
  'runToken',
  'authorization',
  'secret',
  'password',
  'cookie',
]);
