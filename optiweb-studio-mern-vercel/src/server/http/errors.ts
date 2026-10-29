/**
 * Typed API errors. Route handlers throw these; the response mapper turns them
 * into a consistent JSON envelope with the right status code.
 */

export type ApiErrorCode =
  | "bad_request"
  | "validation_error"
  | "payload_too_large"
  | "too_many_files"
  | "unsupported_media_type"
  | "rate_limited"
  | "not_found"
  | "unprocessable_entity"
  | "storage_unavailable"
  | "internal_error";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: unknown;
  readonly hint?: string;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    options?: { details?: unknown; hint?: string },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = options?.details;
    this.hint = options?.hint;
  }
}

export const badRequest = (message: string, hint?: string) =>
  new ApiError(400, "bad_request", message, { hint });

export const validationError = (message: string, details?: unknown) =>
  new ApiError(422, "validation_error", message, { details });

export const payloadTooLarge = (message: string, hint?: string) =>
  new ApiError(413, "payload_too_large", message, { hint });

export const tooManyFiles = (message: string, hint?: string) =>
  new ApiError(413, "too_many_files", message, { hint });

export const unsupportedMedia = (message: string, hint?: string) =>
  new ApiError(415, "unsupported_media_type", message, { hint });

export const rateLimited = (message: string, retryAfterSeconds: number) =>
  new ApiError(429, "rate_limited", message, { details: { retryAfterSeconds } });

export const notFound = (message = "Resource not found") =>
  new ApiError(404, "not_found", message);

export const unprocessable = (message: string, hint?: string) =>
  new ApiError(422, "unprocessable_entity", message, { hint });

export const storageUnavailable = (message: string, hint?: string) =>
  new ApiError(503, "storage_unavailable", message, { hint });
