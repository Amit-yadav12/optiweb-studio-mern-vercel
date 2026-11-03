import { randomUUID } from "node:crypto";
import { jsonOk, route } from "../../src/server/http/handler";
import { APP_NAME } from "../../src/server/config/env";
import { probeMongo } from "../../src/server/db/mongo";
import * as image from "../../src/server/routeHandlers/images/optimize/route";
import * as batch from "../../src/server/routeHandlers/images/optimize/batch/route";
import * as assets from "../../src/server/routeHandlers/assets/analyze/route";
import * as css from "../../src/server/routeHandlers/css/analyze/route";
import * as patch from "../../src/server/routeHandlers/css/patch-font-display/route";
import * as audits from "../../src/server/routeHandlers/audits/route";
import * as history from "../../src/server/routeHandlers/history/route";
import * as historyDetail from "../../src/server/routeHandlers/history/[id]/route";
import * as artifact from "../../src/server/routeHandlers/artifacts/[id]/route";
import * as zip from "../../src/server/routeHandlers/artifacts/zip/route";
import * as limits from "../../src/server/routeHandlers/limits/route";
import * as preferences from "../../src/server/routeHandlers/preferences/route";
import * as session from "../../src/server/routeHandlers/session/route";

type Handler = (request: Request) => Promise<Response>;

function failure(status: number, code: string, message: string, headers?: HeadersInit) {
  return Response.json({ ok: false, error: { code, message }, meta: { requestId: randomUUID() } }, {
    status, headers: { "cache-control": "no-store", ...headers },
  });
}

async function dispatch(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname.replace(/\/$/, "");
  const health = route(async (_req, ctx) => {
    const database = await probeMongo();
    return jsonOk({ ok: database.connected, service: APP_NAME, database, timestamp: new Date().toISOString() }, ctx);
  });
  const routes: Record<string, Record<string, Handler>> = {
    "/api/health": { GET: health },
    "/api/v1/health": { GET: health },
    "/api/v1/images/optimize": { POST: image.POST },
    "/api/v1/images/optimize/batch": { POST: batch.POST },
    "/api/v1/assets/analyze": { POST: assets.POST },
    "/api/v1/css/analyze": { POST: css.POST },
    "/api/v1/css/patch-font-display": { POST: patch.POST },
    "/api/v1/audits": { POST: audits.POST },
    "/api/v1/history": { GET: history.GET, DELETE: history.DELETE },
    "/api/v1/artifacts/zip": { POST: zip.POST },
    "/api/v1/limits": { GET: limits.GET },
    "/api/v1/preferences": { GET: preferences.GET, PUT: preferences.PUT },
    "/api/v1/session": { GET: session.GET },
  };
  let methods = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined;
  const match = pathname.match(/^\/api\/v1\/(history|artifacts)\/([^/]+)$/);
  if (!methods && match) {
    const segment = { params: Promise.resolve({ id: decodeURIComponent(match[2]) }) };
    methods = match[1] === "history"
      ? { GET: (req) => historyDetail.GET(req, segment), DELETE: (req) => historyDetail.DELETE(req, segment) }
      : { GET: (req) => artifact.GET(req, segment) };
  }
  if (!methods) return failure(404, "not_found", "API route not found.");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { Allow: Object.keys(methods).join(", ") } });
  const handler = Object.hasOwn(methods, request.method) ? methods[request.method] : undefined;
  if (!handler) return failure(405, "method_not_allowed", "Method not allowed.", { Allow: Object.keys(methods).join(", ") });
  return handler(request);
}

export default async function handler(request: Request): Promise<Response> {
  let response: Response;
  try {
    response = await dispatch(request);
  } catch {
    response = failure(500, "internal_error", "The request could not be completed.");
  }
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  return response;
}

export const config = { path: "/api/*" };
