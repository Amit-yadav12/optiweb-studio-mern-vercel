import express, { type NextFunction, type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import path from "node:path";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { APP_NAME } from "./server/config/env.js";
import { probeMongo } from "./server/db/mongo.js";
import { jsonOk, route as routeWrapper } from "./server/http/handler.js";
import { isValidRequestId, runWithRequestContext } from "./server/http/requestContext.js";
import * as imageOptimize from "./server/routeHandlers/images/optimize/route.js";
import * as imageBatch from "./server/routeHandlers/images/optimize/batch/route.js";
import * as assetsAnalyze from "./server/routeHandlers/assets/analyze/route.js";
import * as cssAnalyze from "./server/routeHandlers/css/analyze/route.js";
import * as cssPatch from "./server/routeHandlers/css/patch-font-display/route.js";
import * as audits from "./server/routeHandlers/audits/route.js";
import * as history from "./server/routeHandlers/history/route.js";
import * as historyDetail from "./server/routeHandlers/history/[id]/route.js";
import * as artifact from "./server/routeHandlers/artifacts/[id]/route.js";
import * as artifactZip from "./server/routeHandlers/artifacts/zip/route.js";
import * as limitsRoute from "./server/routeHandlers/limits/route.js";
import * as preferences from "./server/routeHandlers/preferences/route.js";
import * as session from "./server/routeHandlers/session/route.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// Correlate a browser request with safe, minimal server diagnostics. Never log
// request bodies, cookies, filenames, or environment values.
app.use((req, res, next) => {
  const supplied = req.get("x-request-id");
  const requestId = isValidRequestId(supplied) ? supplied : randomUUID();
  const startedAt = Date.now();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () => {
    if (res.statusCode >= 500) {
      console.error(`[request] id=${requestId} method=${req.method} path=${req.path} status=${res.statusCode} durationMs=${Date.now() - startedAt}`);
    }
  });
  next();
});

const allowedOrigins = (process.env.CLIENT_ORIGIN ?? "").split(",").map((item) => item.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
    res.status(204).end();
    return;
  }
  next();
});

// Netlify encodes binary function payloads as Base64 before invoking the
// Function. Keep this raw-parser limit below its effective ~4.5 MB binary
// request budget while preserving multipart boundaries for the Web Request API.
app.use("/api", express.raw({ type: () => true, limit: "4.1mb" }));

type WebHandler = (request: Request) => Promise<Response>;
type DynamicWebHandler = (request: Request, segment: { params: Promise<{ id: string }> }) => Promise<Response>;

function toWebRequest(req: ExpressRequest): Request {
  const host = req.get("host") ?? "localhost";
  const protocol = req.headers["x-forwarded-proto"]?.toString().split(",")[0] ?? req.protocol;
  const url = new URL(req.originalUrl || req.url, `${protocol}://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (typeof value === "string") headers.set(key, value);
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : undefined;
  if (raw && req.method !== "GET" && req.method !== "HEAD") {
    return new Request(url, { method: req.method, headers, body: new Uint8Array(raw) });
  }
  return new Request(url, { method: req.method, headers });
}

/**
 * Runs a handler with this request's ID readable by everything it calls. The
 * storage layer uses it to put the same ID in its log lines that the client
 * receives in `X-Request-Id` and `meta.requestId`. The context is entered here,
 * after body parsing, so it does not depend on how a parser schedules callbacks.
 */
function inRequestContext<T>(res: ExpressResponse, run: () => T): T {
  return runWithRequestContext({ requestId: String(res.locals.requestId) }, run);
}

function bridge(handler: WebHandler) {
  return async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    try {
      const result = await inRequestContext(res, () => handler(toWebRequest(req)));
      await sendWebResponse(result, res);
    } catch (error) { next(error); }
  };
}

function bridgeDynamic(handler: DynamicWebHandler) {
  return async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    try {
      const rawId = req.params.id;
      const result = await inRequestContext(res, () => handler(toWebRequest(req), { params: Promise.resolve({ id: Array.isArray(rawId) ? rawId[0] ?? "" : rawId }) }));
      await sendWebResponse(result, res);
    } catch (error) { next(error); }
  };
}

async function sendWebResponse(response: Response, res: ExpressResponse): Promise<void> {
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.status(response.status);
  if (response.status === 204 || response.status === 304) { res.end(); return; }
  const bytes = Buffer.from(await response.arrayBuffer());
  res.send(bytes);
}

// Both health endpoints answer HTTP 200 whenever the API itself is running and
// report database readiness in the body, because every tool except history and
// downloads works without a database. `database` holds only booleans, a latency
// and, when not ready, a failure category with fixed wording: never the
// connection string, a host name or a driver message.
//
// `/api/health` is the liveness check: its `ok` is true when the API answers.
app.get("/api/health", async (_req, res) => {
  const database = await inRequestContext(res, () => probeMongo());
  let sharpVersion: string | undefined;
  try { sharpVersion = `${sharp.versions.sharp} (libvips ${sharp.versions.vips})`; } catch { /* optional runtime detail */ }
  res.status(200).json({
    ok: true,
    service: APP_NAME,
    version: process.env.npm_package_version ?? "1.0.0",
    database,
    sharp: { available: Boolean(sharpVersion), versions: sharpVersion },
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});
// `/api/v1/health` is the readiness check: `data.ok` is true only when the
// database accepted the connection, answered a ping, and accepted a read and
// a write command on the job collection.
app.get("/api/v1/health", bridge(routeWrapper(async (_request, ctx) => {
  const database = await probeMongo();
  let sharpVersion: string | undefined;
  try { sharpVersion = `${sharp.versions.sharp} (libvips ${sharp.versions.vips})`; } catch { /* optional */ }
  const body = { ok: database.ready, service: APP_NAME, version: process.env.npm_package_version ?? "1.1.0", database, sharp: { available: Boolean(sharpVersion), versions: sharpVersion }, uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() };
  return jsonOk(body, ctx);
})));

app.post("/api/v1/images/optimize", bridge(imageOptimize.POST));
app.post("/api/v1/images/optimize/batch", bridge(imageBatch.POST));
app.post("/api/v1/assets/analyze", bridge(assetsAnalyze.POST));
app.post("/api/v1/css/analyze", bridge(cssAnalyze.POST));
app.post("/api/v1/css/patch-font-display", bridge(cssPatch.POST));
app.post("/api/v1/audits", bridge(audits.POST));
app.get("/api/v1/history", bridge(history.GET));
app.delete("/api/v1/history", bridge(history.DELETE));
app.get("/api/v1/history/:id", bridgeDynamic(historyDetail.GET));
app.delete("/api/v1/history/:id", bridgeDynamic(historyDetail.DELETE));
app.get("/api/v1/artifacts/:id", bridgeDynamic(artifact.GET));
app.post("/api/v1/artifacts/zip", bridge(artifactZip.POST));
app.get("/api/v1/limits", bridge(limitsRoute.GET));
app.get("/api/v1/preferences", bridge(preferences.GET));
app.put("/api/v1/preferences", bridge(preferences.PUT));
app.get("/api/v1/session", bridge(session.GET));

// Return a consistent 405 for known API paths used with the wrong method.
// This is more actionable for clients than treating a method mismatch as a
// missing route, while preserving 404 for genuinely unknown paths.
const methodNotAllowed = (allow: string[]) => (_req: ExpressRequest, res: ExpressResponse) => {
  res.setHeader("Allow", allow.join(", "));
  res.status(405).json({
    ok: false,
    error: { code: "method_not_allowed", message: `Method not allowed. Use ${allow.join(" or ")}.` },
    meta: { requestId: randomUUID() },
  });
};
app.all("/api/v1/images/optimize", methodNotAllowed(["POST"]));
app.all("/api/v1/images/optimize/batch", methodNotAllowed(["POST"]));
app.all("/api/v1/assets/analyze", methodNotAllowed(["POST"]));
app.all("/api/v1/css/analyze", methodNotAllowed(["POST"]));
app.all("/api/v1/css/patch-font-display", methodNotAllowed(["POST"]));
app.all("/api/v1/audits", methodNotAllowed(["POST"]));
app.all("/api/v1/history", methodNotAllowed(["GET", "DELETE"]));
app.all("/api/v1/history/:id", methodNotAllowed(["GET", "DELETE"]));
app.all("/api/v1/artifacts/zip", methodNotAllowed(["POST"]));
app.all("/api/v1/artifacts/:id", methodNotAllowed(["GET"]));
app.all("/api/v1/limits", methodNotAllowed(["GET"]));
app.all("/api/v1/preferences", methodNotAllowed(["GET", "PUT"]));
app.all("/api/v1/session", methodNotAllowed(["GET"]));

app.use("/api", (_req, res) => {
  res.status(404).json({ ok: false, error: { code: "not_found", message: "API route not found." }, meta: { requestId: randomUUID() } });
});

const root = path.resolve(process.cwd());
const dist = path.join(root, "dist");
app.use(express.static(dist, { index: false, maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(dist, "index.html"), (error) => {
    if (error && !res.headersSent) res.status(404).send("Frontend build not found. Run npm run build first.");
  });
});

app.use((error: unknown, _req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
  // Express identifies an error middleware by its four-argument signature.
  void next;
  const maybe = error as { status?: number; statusCode?: number; type?: string };
  const requestId = String(res.locals.requestId ?? randomUUID());
  if (maybe.type === "entity.too.large") {
    res.status(413).json({ ok: false, error: { code: "payload_too_large", message: "Request exceeds the deployment-safe 4.1 MB body limit.", hint: "Use a smaller file or split the batch." }, meta: { requestId } });
    return;
  }
  const status = Number(maybe.status ?? maybe.statusCode);
  const safeStatus = status >= 400 && status < 500 ? status : 500;
  if (safeStatus === 500) console.error(`[express] request ${requestId} failed (${error instanceof Error ? error.name : "unknown error"})`);
  res.status(safeStatus).json({ ok: false, error: { code: safeStatus === 500 ? "internal_error" : "request_error", message: safeStatus === 500 ? "The request could not be completed." : "The request was rejected." }, meta: { requestId } });
});

export default app;
