/**
 * HTTP endpoints of the direct-upload pipeline.
 *
 *   POST   /api/v1/jobs/image-optimization   admit a job (201; 200 on an idempotent replay)
 *   GET    /api/v1/jobs/:id                  status with real completion counts
 *   POST   /api/v1/jobs/:id/cancel
 *   POST   /api/v1/jobs/:id/retry            (202)
 *   POST   /api/v1/uploads/token             authorize one direct upload
 *   POST   /api/v1/uploads/complete          verify an upload (202 when it queued the job)
 *   DELETE /api/v1/uploads/:id               remove a file before processing
 *   GET    /api/v1/usage                     the session's storage and limits
 *   GET    /api/v1/artifacts/:id/status
 *
 * Every endpoint acts on the session in the request's cookie only.
 */
import { timingSafeEqual } from "node:crypto";
import { ApiError } from "../../http/errors.js";
import { jsonOk, parseJson, route, routeWithParams } from "../../http/handler.js";
import { runCleanup } from "../../pipeline/cleanup.js";
import { cancelImageJob, completeUpload, createImageJob, getImageJob, issueUploadGrant, removeUpload, retryImageJob } from "../../pipeline/jobs.js";
import { consumeSharedRateLimit } from "../../pipeline/usage.js";
import { applicationUsage, objectArtifactStatus, usageSummary } from "../../pipeline/views.js";
import { getArtifact } from "../../services/storageService.js";
import { notFound } from "../../http/errors.js";
import { createImageJobSchema, imageSettingsSchema, uploadRefSchema } from "../../validators/index.js";

export const createJob = route(async (req, ctx) => {
  // Counted before the body is looked at, so that invalid requests are limited too.
  await consumeSharedRateLimit("jobs/create", ctx.sessionId);
  const input = await parseJson(req, createImageJobSchema);
  const headerKey = req.headers.get("idempotency-key");
  const idempotencyKey = input.idempotencyKey ?? (headerKey && /^[A-Za-z0-9_-]{8,80}$/.test(headerKey) ? headerKey : undefined);
  const result = await createImageJob(ctx.sessionId, { files: input.files, settings: imageSettingsSchema.parse(input.settings ?? {}), idempotencyKey });
  return jsonOk(result, ctx, { status: result.replayed ? 200 : 201 });
}, { bucket: "jobs/create" });

export const getJob = routeWithParams<{ id: string }>(async (_req, ctx, { id }) => {
  return jsonOk({ job: await getImageJob(ctx.sessionId, id) }, ctx);
}, { bucket: "jobs/read" });

export const cancelJob = routeWithParams<{ id: string }>(async (_req, ctx, { id }) => {
  await consumeSharedRateLimit("jobs/control", ctx.sessionId);
  return jsonOk({ job: await cancelImageJob(ctx.sessionId, id) }, ctx);
}, { bucket: "jobs/control" });

export const retryJob = routeWithParams<{ id: string }>(async (_req, ctx, { id }) => {
  await consumeSharedRateLimit("jobs/control", ctx.sessionId);
  return jsonOk({ job: await retryImageJob(ctx.sessionId, id) }, ctx, { status: 202 });
}, { bucket: "jobs/control" });

export const uploadToken = route(async (req, ctx) => {
  await consumeSharedRateLimit("uploads/token", ctx.sessionId);
  const { uploadId } = await parseJson(req, uploadRefSchema);
  return jsonOk({ upload: await issueUploadGrant(ctx.sessionId, uploadId) }, ctx);
}, { bucket: "uploads/token" });

export const uploadComplete = route(async (req, ctx) => {
  await consumeSharedRateLimit("uploads/complete", ctx.sessionId);
  const { uploadId } = await parseJson(req, uploadRefSchema);
  const result = await completeUpload(ctx.sessionId, uploadId);
  // 202: this confirmation was the last one, and the job is now with the worker.
  return jsonOk(result, ctx, { status: result.queued ? 202 : 200 });
}, { bucket: "uploads/complete" });

export const uploadDelete = routeWithParams<{ id: string }>(async (_req, ctx, { id }) => {
  await consumeSharedRateLimit("jobs/control", ctx.sessionId);
  return jsonOk({ job: await removeUpload(ctx.sessionId, id) }, ctx);
}, { bucket: "jobs/control" });

export const usage = route(async (_req, ctx) => jsonOk(await usageSummary(ctx.sessionId), ctx), { bucket: "usage" });

/** Whether a generated file can still be downloaded, without downloading it. */
export const artifactStatus = routeWithParams<{ id: string }>(async (_req, ctx, { id }) => {
  const stored = await objectArtifactStatus(ctx.sessionId, id);
  if (stored) return jsonOk(stored, ctx);
  const inline = await getArtifact(ctx.sessionId, id);
  if (!inline) throw notFound("That result has expired or belongs to another session.");
  return jsonOk({ id, state: "available" as const, filename: inline.filename, contentType: inline.contentType, bytes: inline.data.byteLength, expiresAt: inline.expiresAt.toISOString() }, ctx);
}, { bucket: "artifacts" });

/* ---------------------------------------------------------------- operators */

/** Compares a bearer token with a secret in constant time. False when the secret is not configured. */
function bearerMatches(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function requireOperator(req: Request, secrets: Array<string | undefined>): void {
  if (!secrets.some(Boolean)) {
    throw new ApiError(503, "storage_unavailable", "This endpoint is not configured.", { hint: "Set CRON_SECRET in the server environment." });
  }
  if (!secrets.some((secret) => bearerMatches(req, secret))) throw new ApiError(401, "unauthorized", "Missing or wrong credentials.");
}

/**
 * GET or POST /api/v1/internal/cron — retention and repair. The scheduler
 * calls it with `Authorization: Bearer $CRON_SECRET`. Without that secret
 * configured the endpoint refuses to run, so it cannot be triggered by anyone.
 */
export const cron = route(async (req, ctx) => {
  requireOperator(req, [process.env.CRON_SECRET]);
  return jsonOk(await runCleanup(), ctx);
});

/** GET /api/v1/internal/usage — application-wide usage against the configured budgets. */
export const adminUsage = route(async (req, ctx) => {
  requireOperator(req, [process.env.OW_ADMIN_TOKEN, process.env.CRON_SECRET]);
  return jsonOk(await applicationUsage(), ctx);
});
