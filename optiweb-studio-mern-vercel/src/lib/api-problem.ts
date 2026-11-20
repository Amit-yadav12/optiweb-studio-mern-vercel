/**
 * Wording for a response from an API path that is not the API's JSON.
 *
 * The API answers every request, including unknown routes and errors, with a
 * JSON envelope. A body that is not JSON therefore came from the host in front
 * of it. The most common case is HTTP 404: the site is deployed as static
 * files only, without its server function.
 */
export type ApiProblem = { code: string; message: string; hint: string };

export function describeNonJsonResponse(status: number, requestId: string | null): ApiProblem {
  if (status === 404) {
    return {
      code: "api_unavailable",
      message: "The audit service is not available on this site (HTTP 404).",
      hint: "The request did not reach the API: the host answered with its own \"not found\" page. This usually means the site is running a deployment without its server function. The image, font and asset tools are not affected, because they run in this browser. If you manage this site, put the current build into production.",
    };
  }
  return {
    code: "bad_response",
    message: `The audit service returned a response that is not JSON (HTTP ${status}).`,
    hint: requestId ? `Reference ${requestId}. Try again in a moment.` : "Try again in a moment.",
  };
}
