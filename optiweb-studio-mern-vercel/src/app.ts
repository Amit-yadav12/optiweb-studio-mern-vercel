/**
 * The Unikit Studio server.
 *
 * It serves the built app and one API endpoint, the website audit, which has
 * to run on a server because a browser may not fetch another site's pages.
 *
 * What it deliberately does not have:
 *  - no route that accepts a file (no multipart parser, no raw body parser);
 *  - no database, no object storage, no background jobs;
 *  - no cookies and no sessions.
 * Images, stylesheets and asset files are processed in the visitor's browser
 * and are never sent here.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { APP_NAME, APP_VERSION, MAX_JSON_BODY_BYTES, limits } from "./server/config/env.js";
import { SECURITY_HEADERS } from "./server/config/securityHeaders.js";
import { ApiError, payloadTooLarge, rateLimited, unsupportedMedia, validationError } from "./server/http/errors.js";
import { consumeRateLimit } from "./server/middleware/rateLimit.js";
import { runWebsiteAudit } from "./server/services/auditService.js";
import { auditRequestSchema } from "./server/validators/index.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const REQUEST_ID = /^[A-Za-z0-9._-]{8,80}$/;

// One ID per request, returned in `X-Request-Id` and in `meta.requestId`.
// Request bodies, URLs to audit and client addresses are never logged.
app.use((req, res, next) => {
  const supplied = req.get("x-request-id");
  const requestId = supplied && REQUEST_ID.test(supplied) ? supplied : randomUUID();
  const startedAt = Date.now();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  res.on("finish", () => {
    if (res.statusCode >= 500) {
      console.error(`[request] id=${requestId} method=${req.method} path=${req.path} status=${res.statusCode} durationMs=${Date.now() - startedAt}`);
    }
  });
  next();
});

const requestIdOf = (res: Response): string => String(res.locals.requestId ?? randomUUID());

function sendOk(res: Response, data: unknown, extra?: Record<string, unknown>): void {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ok: true, data, meta: { requestId: requestIdOf(res), ...extra } });
}

function sendError(res: Response, error: ApiError): void {
  res.setHeader("Cache-Control", "no-store");
  if (error.code === "rate_limited") {
    const retry = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    if (retry) res.setHeader("Retry-After", String(retry));
  }
  res.status(error.status).json({
    ok: false,
    error: { code: error.code, message: error.message, hint: error.hint, details: error.details },
    meta: { requestId: requestIdOf(res) },
  });
}

/** What this deployment is, for monitoring and for the interface. Nothing here depends on an external service. */
function describeService() {
  return {
    ok: true,
    service: APP_NAME,
    version: APP_VERSION,
    processing: { images: "browser", stylesheets: "browser", assets: "browser", audit: "server" },
    acceptsFileUploads: false,
    storesFiles: false,
    usesCookies: false,
    audit: {
      maxPages: limits.auditMaxPages,
      maxResourcesPerPage: limits.auditMaxResources,
      pagespeedConfigured: Boolean(process.env.PAGESPEED_API_KEY),
    },
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

// Liveness, without the envelope, for uptime monitors.
app.get("/api/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(describeService());
});
app.get("/api/v1/health", (_req, res) => sendOk(res, describeService()));

/**
 * POST /api/v1/audits: fetches a public page and the assets it names, and
 * reports what was measured. The request body is a URL and a page count. The
 * report goes back in the response and is not kept.
 */
app.post(
  "/api/v1/audits",
  (req, _res, next) => {
    // Refuse before reading: this endpoint takes a small JSON document and nothing else.
    if (!req.is("application/json")) {
      next(unsupportedMedia("This endpoint accepts application/json only.", "Send { \"url\": \"https://…\" }. Files are not accepted by any endpoint."));
      return;
    }
    next();
  },
  express.json({ limit: MAX_JSON_BODY_BYTES, type: "application/json", strict: true }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = consumeRateLimit("audits", req.ip ?? "unknown");
      if (!limit.allowed) throw rateLimited("Too many audits. Wait a moment and try again.", limit.retryAfterSeconds);
      const parsed = auditRequestSchema.safeParse(req.body);
      if (!parsed.success) throw validationError("Request payload failed validation.", flattenZod(parsed.error));
      const report = await runWebsiteAudit(parsed.data.url, { extraPages: parsed.data.extraPages });
      sendOk(res, report, { rateLimit: { limit: limit.limit, remaining: limit.remaining } });
    } catch (error) {
      next(error);
    }
  },
);

function flattenZod(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.join(".") || "body", message: issue.message }));
}

const methodNotAllowed = (allow: string[]) => (_req: Request, res: Response) => {
  res.setHeader("Allow", allow.join(", "));
  sendError(res, new ApiError(405, "method_not_allowed", `Method not allowed. Use ${allow.join(" or ")}.`));
};
app.all("/api/health", methodNotAllowed(["GET"]));
app.all("/api/v1/health", methodNotAllowed(["GET"]));
app.all("/api/v1/audits", methodNotAllowed(["POST"]));

/**
 * Endpoints of earlier versions, which uploaded files to this server and kept
 * results. They answer 410 Gone, without reading the request body, so that an
 * old client gets a clear answer instead of a silent failure.
 */
const REMOVED = /^\/api\/v1\/(images|assets|css|jobs|uploads|artifacts|history|usage|preferences|session|limits|internal)(\/|$)/;
app.use((req, res, next) => {
  if (!REMOVED.test(req.path)) {
    next();
    return;
  }
  sendError(
    res,
    new ApiError(410, "gone", "This endpoint was removed.", {
      hint: `${APP_NAME} processes images, stylesheets and asset files in the browser. The server accepts no files and stores nothing.`,
    }),
  );
});

app.use("/api", (_req, res) => {
  sendError(res, new ApiError(404, "not_found", "API route not found."));
});

const dist = path.join(path.resolve(process.cwd()), "dist");
app.use(
  express.static(dist, {
    index: false,
    setHeaders: (res, filePath) => {
      // Hashed build files never change; everything else is revalidated.
      res.setHeader("Cache-Control", /[\\/]assets[\\/]/.test(filePath) ? "public, max-age=31536000, immutable" : "no-cache");
    },
  }),
);
// A build file that does not exist is a 404, not the app's page: a browser
// that asks for a script must never be handed HTML.
app.use("/assets", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(404).type("text/plain").send("Not found. This file is not part of the current build. Reload the page to get the current one.\n");
});
app.get(/.*/, (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(dist, "index.html"), (error) => {
    if (error && !res.headersSent) res.status(404).type("text/plain").send("Frontend build not found. Run npm run build first.");
  });
});

// Pages are read with GET. No route here accepts a body, so any other method on a page path is refused.
app.use((_req, res) => {
  res.setHeader("Allow", "GET, HEAD");
  sendError(res, new ApiError(405, "method_not_allowed", "Method not allowed. Pages are served with GET; no route accepts a file."));
});

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  // Express identifies an error middleware by its four-argument signature.
  void next;
  if (res.headersSent) return;
  if (error instanceof ApiError) {
    sendError(res, error);
    return;
  }
  const maybe = error as { status?: number; statusCode?: number; type?: string };
  if (maybe.type === "entity.too.large") {
    sendError(res, payloadTooLarge(`The request body is larger than ${MAX_JSON_BODY_BYTES / 1024} KB.`, "An audit request holds a URL and a page count. Files are not accepted by any endpoint."));
    return;
  }
  if (maybe.type === "entity.parse.failed") {
    sendError(res, new ApiError(400, "bad_request", "Request body must be valid JSON."));
    return;
  }
  const status = Number(maybe.status ?? maybe.statusCode);
  if (status >= 400 && status < 500) {
    sendError(res, new ApiError(status, "request_error", "The request could not be processed."));
    return;
  }
  // Exception messages are not logged: they can contain the URL that was audited.
  console.error(`[api] request ${requestIdOf(res)} failed (${error instanceof Error ? error.name : "unknown error"})`);
  sendError(res, new ApiError(500, "internal_error", "The request could not be completed."));
});

export default app;
