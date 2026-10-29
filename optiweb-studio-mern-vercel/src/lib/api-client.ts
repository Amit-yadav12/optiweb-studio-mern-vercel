/** Typed browser client for the /api/v1 contract. Unwraps the response envelope. */

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

type FailureBody = {
  ok: false;
  error: { code: string; message: string; hint?: string; details?: unknown };
};

export type RequestOptions = {
  signal?: AbortSignal;
};

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      credentials: apiBase ? "include" : "same-origin",
      headers:
        init.body instanceof FormData
          ? init.headers
          : { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (error) {
    if (isAbortError(error) || init.signal?.aborted) {
      throw new ApiClientError("The request was cancelled.", {
        code: "cancelled",
        status: 0,
      });
    }
    throw new ApiClientError("The network request could not be completed.", {
      code: "network_error",
      hint: "Check your connection and try again.",
      status: 0,
    });
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiClientError("The server returned an unreadable response.", {
      code: "bad_response",
      status: response.status,
    });
  }

  if (!response.ok || (parsed as FailureBody | null)?.ok === false) {
    const failure = parsed as FailureBody | null;
    throw new ApiClientError(failure?.error.message ?? "The request failed.", {
      code: failure?.error.code ?? "unknown_error",
      hint: failure?.error.hint,
      status: response.status,
    });
  }

  return (parsed as { data: T }).data;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>(path, { method: "GET", signal: options?.signal }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, {
      method: "POST",
      signal: options?.signal,
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    }),
  put: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>(path, { method: "PUT", signal: options?.signal, body: JSON.stringify(body) }),
  del: <T>(path: string, options?: RequestOptions) => request<T>(path, { method: "DELETE", signal: options?.signal }),
};

/**
 * URL of a stored artifact.
 * `download` → served as an attachment; otherwise → served inline so it can be
 * used as an <img> preview.
 */
export function artifactUrl(id: string, download = true): string {
  return `/api/v1/artifacts/${id}${download ? "?download=1" : "?inline=1"}`;
}

/** Triggers a browser download for the selected artifacts as one ZIP. */
export async function downloadZip(ids: string[], name = "optiweb-results", signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${(import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "")}/api/v1/artifacts/zip`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids, name }),
    credentials: (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "") ? "include" : "same-origin",
    signal,
  });
  if (!response.ok) {
    let message = "The bundle could not be created.";
    try {
      const body = (await response.json()) as FailureBody;
      message = body.error.message;
    } catch {
      /* keep default */
    }
    throw new ApiClientError(message, { code: "zip_failed", status: response.status });
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  triggerDownload(URL.createObjectURL(blob), match?.[1] ?? `${name}.zip`);
}

export function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // The click is synchronous for blob: URLs; releasing on the next turn is safe
  // and prevents the object URL from leaking for the life of the tab.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
