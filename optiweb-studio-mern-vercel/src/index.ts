import "dotenv/config";
import express, { type NextFunction, type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import path from "node:path";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { APP_NAME } from "@/server/config/env";
import { probeMongo } from "@/server/db/mongo";
import { jsonOk, route as routeWrapper } from "@/server/http/handler";
import * as imageOptimize from "@/server/routeHandlers/images/optimize/route";
import * as imageBatch from "@/server/routeHandlers/images/optimize/batch/route";
import * as assetsAnalyze from "@/server/routeHandlers/assets/analyze/route";
import * as cssAnalyze from "@/server/routeHandlers/css/analyze/route";
import * as cssPatch from "@/server/routeHandlers/css/patch-font-display/route";
import * as audits from "@/server/routeHandlers/audits/route";
import * as history from "@/server/routeHandlers/history/route";
import * as historyDetail from "@/server/routeHandlers/history/[id]/route";
import * as artifact from "@/server/routeHandlers/artifacts/[id]/route";
import * as artifactZip from "@/server/routeHandlers/artifacts/zip/route";
import * as limitsRoute from "@/server/routeHandlers/limits/route";
import * as preferences from "@/server/routeHandlers/preferences/route";
import * as session from "@/server/routeHandlers/session/route";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

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

// Vercel Functions cap request bodies at 4.5 MB. Keep a conservative margin so
// multipart framing and JSON envelopes do not hit the platform's hard limit.
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

function bridge(handler: WebHandler) {
  return async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    try {
      const result = await handler(toWebRequest(req));
      await sendWebResponse(result, res);
    } catch (error) { next(error); }
  };
}

function bridgeDynamic(handler: DynamicWebHandler) {
  return async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    try {
      const result = await handler(toWebRequest(req), { params: Promise.resolve({ id: req.params.id }) });
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

app.get("/api/health", async (_req, res) => {
  const database = await probeMongo();
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
app.get("/api/v1/health", bridge(routeWrapper(async (_request, ctx) => {
  const database = await probeMongo();
  let sharpVersion: string | undefined;
  try { sharpVersion = `${sharp.versions.sharp} (libvips ${sharp.versions.vips})`; } catch { /* optional */ }
  const body = { ok: database.connected, service: APP_NAME, version: process.env.npm_package_version ?? "1.1.0", database, sharp: { available: Boolean(sharpVersion), versions: sharpVersion }, uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() };
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

app.use((error: unknown, _req: ExpressRequest, res: ExpressResponse, _next: NextFunction) => {
  const maybe = error as { status?: number; statusCode?: number; type?: string; message?: string };
  if (maybe.type === "entity.too.large") {
    res.status(413).json({ ok: false, error: { code: "payload_too_large", message: "Request exceeds the deployment-safe 4.1 MB body limit.", hint: "Use a smaller file or split the batch." }, meta: { requestId: randomUUID() } });
    return;
  }
  const status = Number(maybe.status ?? maybe.statusCode);
  const safeStatus = status >= 400 && status < 500 ? status : 500;
  console.error(`[express] ${maybe.message ?? "request error"}`);
  res.status(safeStatus).json({ ok: false, error: { code: safeStatus === 500 ? "internal_error" : "request_error", message: safeStatus === 500 ? "The request could not be completed." : "The request was rejected." }, meta: { requestId: randomUUID() } });
});

if (process.env.VERCEL !== "1") {
  const port = Number(process.env.PORT ?? 5000);
  app.listen(port, () => console.log(`${APP_NAME} API and static app listening on http://localhost:${port}`));
}

export default app;
