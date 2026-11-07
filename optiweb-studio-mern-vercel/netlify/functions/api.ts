import type { IncomingMessage } from "node:http";
import serverless from "serverless-http";
import app from "../../src/app.js";

const FUNCTION_MOUNT = "/.netlify/functions/api";

/**
 * Netlify's /api/* rewrite normally preserves the original /api/... path, which
 * matches src/app.ts. Also strip the generated function mount prefix when the
 * default /.netlify/functions/api endpoint is invoked directly (e.g. by the
 * Functions emulator), without altering normal rewritten API requests.
 */
function normalizeFunctionPath(request: IncomingMessage): void {
  const requestPath = request.url ?? "/";
  if (requestPath === FUNCTION_MOUNT) {
    request.url = "/";
  } else if (requestPath.startsWith(`${FUNCTION_MOUNT}/`)) {
    request.url = requestPath.slice(FUNCTION_MOUNT.length);
  }
}

export const handler = serverless(app, {
  request: normalizeFunctionPath,
  binary: ["application/octet-stream", "application/zip", "image/*", "font/*"],
});
