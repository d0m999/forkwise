// execute 的「结果未知」出口，前后端共用同一份常量（ADR0028）。
// 未知异常由 http.ts 兜底成 503 SAVE_FAILED，可能发生在事务提交之后；
// 传输层故障没有响应体，API 层补 UNAVAILABLE。除此之外都是 DomainError 业务拒绝，
// 事务已回滚、可确认未提交（包括 SNAPSHOT_UNAVAILABLE 这类 503）。
export const EXECUTE_FALLBACK_CODE = 'SAVE_FAILED';
export const TRANSPORT_FALLBACK_CODE = 'UNAVAILABLE';
export const UNKNOWN_RESULT_CODES: readonly string[] = [EXECUTE_FALLBACK_CODE, TRANSPORT_FALLBACK_CODE];
