import { randomUUID } from "node:crypto";
import { ZodError, type ZodType } from "zod";
import { ApiError, type ApiErrorCode, validationError } from "@/server/http/errors";
import { consumeRateLimit, type RateLimitResult } from "@/server/middleware/rateLimit";
import type { RateLimitBucket } from "@/server/config/env";

export const SESSION_COOKIE = "ow_sid";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export type ApiMeta = {
  requestId: string;
  rateLimit?: { limit: number; remaining: number };
};

/** Dynamic route segment parameters passed by the API adapter. */
export type SegmentParams<P extends Record<string, string>> = { params: Promise<P> };

export type ApiSuccess<T> = { ok: true; data: T; meta: ApiMeta };
export type ApiFailure = {
  ok: false;
  error: { code: ApiErrorCode; message: string; hint?: string; details?: unknown };
  meta: ApiMeta;
};
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** Request context handed to every controller. */
export type RouteContext = {
  requestId: string;
  sessionId: string;
  /** True when this request issued a brand-new guest session. */
  sessionIssued: boolean;
  rateLimit?: RateLimitResult;
};

type HandlerOptions = {
  bucket?: RateLimitBucket;
};

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      // Browser cookies are untrusted input. A malformed percent escape must
      // not turn an otherwise valid request into a 500 response.
      try { out[key] = decodeURIComponent(value); }
      catch { /* ignore malformed cookie pairs */ }
    }
  }
  return out;
}

/**
 * Reads the guest session id. Sessions are opaque random ids stored in an
 * httpOnly cookie; they scope history and artifacts without any account system.
 */
function resolveSession(req: Request): { sessionId: string; issued: boolean } {
  const cookies = parseCookies(req.headers.get("cookie"));
  const existing = cookies[SESSION_COOKIE];
  if (existing && /^[a-f0-9-]{16,64}$/i.test(existing)) {
    return { sessionId: existing, issued: false };
  }
  return { sessionId: randomUUID(), issued: true };
}

function sessionCookie(sessionId: string): string {
  const attributes = [
    `${SESSION_COOKIE}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  if (process.env.NODE_ENV === "production") attributes.push("Secure");
  return attributes.join("; ");
}

export function jsonOk<T>(
  data: T,
  ctx: RouteContext,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  const body: ApiSuccess<T> = {
    ok: true,
    data,
    meta: {
      requestId: ctx.requestId,
      rateLimit: ctx.rateLimit
        ? { limit: ctx.rateLimit.limit, remaining: ctx.rateLimit.remaining }
        : undefined,
    },
  };
  const headers = new RecordHeaders(init?.headers);
  if (ctx.sessionIssued) headers.append("set-cookie", sessionCookie(ctx.sessionId));
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers.flush() },
  });
}

/** Binary response (file download) that still carries the session cookie. */
export function binaryOk(
  body: BodyInit,
  ctx: RouteContext,
  meta: { contentType: string; filename?: string; headers?: Record<string, string> },
): Response {
  const headers = new RecordHeaders(meta.headers);
  headers.set("content-type", meta.contentType);
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  if (meta.filename) {
    headers.set("content-disposition", contentDisposition(meta.filename));
  }
  if (ctx.sessionIssued) headers.append("set-cookie", sessionCookie(ctx.sessionId));
  return new Response(body, { status: 200, headers: headers.flush() });
}

class RecordHeaders {
  private map = new Map<string, string[]>();
  constructor(entries?: Record<string, string>) {
    if (entries) for (const [k, v] of Object.entries(entries)) this.set(k, v);
  }
  set(key: string, value: string) {
    this.map.set(key, [value]);
  }
  append(key: string, value: string) {
    this.map.set(key, [...(this.map.get(key) ?? []), value]);
  }
  flush(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, values] of this.map) out[key] = values.join(", ");
    return out;
  }
}

/** RFC 5987-safe Content-Disposition value; rejects path separators. */
export function contentDisposition(filename: string): string {
  const safe = filename.replace(/[\r\n"\\/]/g, "_");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function errorResponse(error: unknown, ctx: RouteContext): Response {
  const apiError =
    error instanceof ApiError
      ? error
      : new ApiError(500, "internal_error", "The request could not be completed.");

  if (!(error instanceof ApiError)) {
    // Unexpected errors are logged with type + message only. No user payload,
    // no stack traces with absolute paths, no file contents.
    console.error(
      `[api] request ${ctx.requestId} failed: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`,
    );
  }

  const body: ApiFailure = {
    ok: false,
    error: {
      code: apiError.code,
      message: apiError.message,
      hint: apiError.hint,
      details: apiError.details,
    },
    meta: { requestId: ctx.requestId },
  };
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (apiError.code === "rate_limited") {
    const retry = (apiError.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    if (retry) headers["retry-after"] = String(retry);
  }
  if (ctx.sessionIssued) headers["set-cookie"] = sessionCookie(ctx.sessionId);
  return new Response(JSON.stringify(body), {
    status: apiError.status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/**
 * Wraps a controller with session resolution, rate limiting and centralized
 * error mapping shared by every API endpoint. The Express bridge calls these
 * handlers through the Web Request/Response adapter, keeping validation and
 * session behavior consistent across local development and deployment.
 */
async function execute(
  req: Request,
  options: HandlerOptions,
  run: (ctx: RouteContext) => Promise<Response>,
): Promise<Response> {
  const requestId = randomUUID();
  const { sessionId, issued } = resolveSession(req);
  const ctx: RouteContext = { requestId, sessionId, sessionIssued: issued };

  try {
    if (options.bucket) {
      const result = consumeRateLimit(options.bucket, sessionId);
      ctx.rateLimit = result;
      if (!result.allowed) {
        throw new ApiError(429, "rate_limited", "Too many requests. Please wait a moment and try again.", {
          details: { retryAfterSeconds: result.retryAfterSeconds },
        });
      }
    }
    return await run(ctx);
  } catch (error) {
    if (error instanceof ZodError) {
      return errorResponse(validationError("Request payload failed validation.", flattenZod(error)), ctx);
    }
    return errorResponse(error, ctx);
  }
}

export function route<T>(
  handler: (req: Request, ctx: RouteContext) => Promise<Response>,
  options: HandlerOptions = {},
): (req: Request) => Promise<Response> {
  return (req: Request) => execute(req, options, (ctx) => handler(req, ctx));
}

export function flattenZod(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "body",
    message: issue.message,
  }));
}

export async function parseJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "bad_request", "Request body must be valid JSON.");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw validationError("Request payload failed validation.", flattenZod(result.error));
  }
  return result.data;
}

export function searchParams(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}

/** Same pipeline as `route`, for handlers that need dynamic path segments. */
export function routeWithParams<P extends Record<string, string>>(
  handler: (req: Request, ctx: RouteContext, params: P) => Promise<Response>,
  options: HandlerOptions = {},
): (req: Request, segment: SegmentParams<P>) => Promise<Response> {
  return async (req: Request, segment: SegmentParams<P>) => {
    const params = await segment.params;
    return execute(req, options, (ctx) => handler(req, ctx, params));
  };
}
