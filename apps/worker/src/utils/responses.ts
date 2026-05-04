// Shared helpers for building `ApiResponse<T>` JSON responses.

import type { ApiError, ApiResponse } from "@university-hub/shared";

export function jsonOk<T>(data: T, init: ResponseInit = {}): Response {
  const body: ApiResponse<T> = { ok: true, data };
  return Response.json(body, init);
}

export function jsonError(error: ApiError, headers?: HeadersInit): Response {
  const body: ApiResponse<never> = { ok: false, error };
  return Response.json(body, { status: error.status, headers });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return jsonError({ status, code, message, ...(details ? { details } : {}) });
}
