/**
 * Browser client for the one thing the server does: the website audit.
 *
 * It sends JSON and nothing else. It has no way to send a file: there is no
 * FormData or Blob path here, and the server has no route that would take one.
 * Requests go to this site's own origin only.
 */
import { describeNonJsonResponse } from "@/lib/api-problem";

export class ApiClientError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly status: number;

  constructor(message: string, options: { code: string; hint?: string; status: number }) {
    super(message);
    this.name = "ApiClientError";
    this.code = options.code;
    this.hint = options.hint;
    this.status = options.status;
  }
}

type FailureBody = { ok: false; error: { code: string; message: string; hint?: string } };

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function request<T>(path: string, init: { method: "GET" | "POST"; json?: unknown; signal?: AbortSignal }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method,
      signal: init.signal,
      credentials: "omit",
      headers: init.json === undefined ? undefined : { "content-type": "application/json" },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
  } catch (error) {
    if (isAbortError(error) || init.signal?.aborted) {
      throw new ApiClientError("The request was cancelled.", { code: "cancelled", status: 0 });
    }
    throw new ApiClientError("The network request could not be completed.", { code: "network_error", hint: "Check your connection and try again.", status: 0 });
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    const problem = describeNonJsonResponse(response.status, response.headers.get("x-request-id"));
    throw new ApiClientError(problem.message, { code: problem.code, hint: problem.hint, status: response.status });
  }

  if (!response.ok || (parsed as FailureBody | null)?.ok === false) {
    const failure = parsed as FailureBody | null;
    throw new ApiClientError(failure?.error?.message ?? "The request failed.", {
      code: failure?.error?.code ?? "unknown_error",
      hint: failure?.error?.hint,
      status: response.status,
    });
  }
  return (parsed as { data: T }).data;
}

export const api = {
  get: <T>(path: string, options?: { signal?: AbortSignal }) => request<T>(path, { method: "GET", signal: options?.signal }),
  /** Sends a JSON document. `body` must be plain data. */
  postJson: <T>(path: string, body: unknown, options?: { signal?: AbortSignal }) => request<T>(path, { method: "POST", json: body, signal: options?.signal }),
};
