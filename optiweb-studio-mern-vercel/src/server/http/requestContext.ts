/**
 * Request-scoped context for server-side diagnostics.
 *
 * The request ID is set once, when a request enters the Express app, and is
 * readable from any code that runs while that request is handled, including
 * the database layer. A log line written deep in a storage call therefore
 * carries the same ID as the `X-Request-Id` response header and the
 * `meta.requestId` field of the JSON envelope, without passing the ID through
 * every function signature.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = { requestId: string };

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `callback` with `context` visible to everything it calls, including awaited work. */
export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

/** The ID of the request being handled, or `null` outside a request (startup, tests, background work). */
export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;

/** Accepts a caller-supplied request ID only when it is a short, log-safe token. */
export function isValidRequestId(value: string | null | undefined): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}
