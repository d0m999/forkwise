export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 503;
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: ErrorStatus = 422,
    public details: unknown = null,
  ) {
    super(message);
  }
}
export function requireThat(
  condition: unknown,
  code: string,
  message: string,
  status: ErrorStatus = 422,
): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}
