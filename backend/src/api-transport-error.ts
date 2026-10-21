export interface ApiErrorResponse {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export class ApiTransportError extends Error {
  constructor(readonly response: ApiErrorResponse) {
    super(`${response.code}: ${response.message}`);
    this.name = 'ApiTransportError';
  }
}
