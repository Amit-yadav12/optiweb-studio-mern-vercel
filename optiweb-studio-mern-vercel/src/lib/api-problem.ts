/**
 * Wording for a response from an API path that is not the API's JSON.
 *
 * The API answers every request, including unknown routes and errors, with a
 * JSON envelope. A body that is not JSON therefore came from the host in front
 * of it. The most common case is HTTP 404: the site is deployed without its
 * server function, so the host serves its own "not found" page for /api/*.
 */
export type ApiProblem = { code: string; message: string; hint: string };

export function describeNonJsonResponse(status: number, requestId: string | null): ApiProblem {
  if (status === 404) {
    return {
      code: "api_unavailable",
      message: "The API is not available on this site (HTTP 404).",
      hint: "The request did not reach the API: the host answered with its own \"not found\" page. This usually means the site is running a deployment without its server function. If you manage this site, put the latest deployment into production, then reload this page.",
    };
  }
  return {
    code: "bad_response",
    message: `The API returned a non-JSON response (HTTP ${status}).`,
    hint: requestId ? `Reference ${requestId}; retry or share this reference with support.` : "Retry once. If the problem persists, contact support.",
  };
}
