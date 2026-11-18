/**
 * Lifecycle of a background image job, apart from the processing itself:
 * admission, upload authorization, upload verification, queueing, status,
 * cancellation and retry. `worker.ts` does the processing.
 *
 * Ownership is decided here and nowhere else: every operation loads the record
 * by ID **and** session. An ID, a file name or a storage path sent by a
 * browser never selects another session's data.
 */
import { randomUUID } from "node:crypto";
import { capacity } from "../config/env.js";
import { isMongoConfigured } from "../db/mongo.js";
import { StorageUnavailableError } from "../db/storageDiagnostics.js";
import { ApiError, conflict, notFound, payloadTooLarge, tooManyFiles, unsupportedMedia } from "../http/errors.js";
import { sanitizeFilename } from "../services/imageService.js";
import { sourcePath } from "../storage/objectPaths.js";
import { ObjectStorageError, getObjectStorage, readHead, storageStatus, storageTtlDays, type ObjectStorage } from "../storage/objectStorage.js";
import { stableUuid } from "./ids.js";
import { SIGNATURE_BYTES, rasterContentType, sniffSignature } from "./signature.js";
import { hasPipelineStoreOverride, isDuplicateKey, pipelineStore, type ArtifactRecord, type ItemRecord, type JobItemSnapshot, type JobRecord, type PipelineStore } from "./store.js";
import { kickWorker } from "./trigger.js";
import { acquireJobSlot, reconcileSession, recordDay, releaseJobSlot, releaseReservation, releaseSource, reserveUploadBytes, settleUpload } from "./usage.js";
import type { ImageJob, ImageJobItem, ImageOptimizeSettings, JobItemState, JobState, UploadGrantView } from "../../types/domain.js";

export const ACTIVE_STATES: JobState[] = ["created", "uploading", "uploaded", "queued", "processing"];
export const TERMINAL_STATES: JobState[] = ["completed", "partial", "failed", "cancelled"];
const UPLOAD_PHASE: JobState[] = ["created", "uploading"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MB = 1024 * 1024;

/* ------------------------------------------------------------ availability */

export type PipelineAvailability =
  | { available: true; driver: "vercel-blob" | "local" }
  | { available: false; reason: string; message: string };

const UNAVAILABLE: Record<string, string> = {
  storage_not_configured: "Object storage is not configured on this deployment.",
  storage_disabled: "Object storage is switched off on this deployment.",
  storage_unsupported_host: "This host cannot stream large files, so direct uploads are not used here.",
  storage_local_dir_missing: "The local storage directory is not configured.",
  database_not_configured: "The database is not configured on this deployment.",
  database_unavailable: "The database cannot be reached right now.",
};
const unavailable = (reason: string): PipelineAvailability => ({ available: false, reason, message: UNAVAILABLE[reason] ?? "Direct uploads are not available." });

let databaseCheck: { at: number; ok: boolean; pending: Promise<boolean> | null } = { at: 0, ok: false, pending: null };

/** Whether the pipeline's database answers. The result is reused for a short time, so a database that is down costs one timeout, not one per request. */
function databaseReady(): Promise<boolean> {
  if (hasPipelineStoreOverride()) return Promise.resolve(true);
  const age = Date.now() - databaseCheck.at;
  if (databaseCheck.at > 0 && age < (databaseCheck.ok ? 60_000 : 20_000)) return Promise.resolve(databaseCheck.ok);
  databaseCheck.pending ??= pipelineStore()
    .then(() => true, () => false)
    .then((ok) => {
      databaseCheck = { at: Date.now(), ok, pending: null };
      return ok;
    });
  return databaseCheck.pending;
}

/** Test hook: forget the cached database check. */
export function resetPipelineAvailability(): void {
  databaseCheck = { at: 0, ok: false, pending: null };
}

/**
 * Whether direct uploads work on this deployment right now: object storage is
 * configured and the database answers. With `maxWaitMs`, a database that is
 * slow to answer is reported as unavailable for now instead of delaying the
 * caller; the check keeps running and its result is used next time.
 */
export async function pipelineAvailability(options: { maxWaitMs?: number } = {}): Promise<PipelineAvailability> {
  const storage = await getObjectStorage();
  if (!storage) {
    const status = storageStatus();
    return unavailable(`storage_${status.configured ? "not_configured" : status.reason}`);
  }
  if (!hasPipelineStoreOverride() && !isMongoConfigured()) return unavailable("database_not_configured");
  const check = databaseReady();
  const ready =
    options.maxWaitMs === undefined
      ? await check
      : await Promise.race([check, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), options.maxWaitMs).unref?.())]);
  return ready ? { available: true, driver: storage.driver } : unavailable("database_unavailable");
}

export type Pipeline = { store: PipelineStore; storage: ObjectStorage };

/** The pipeline's dependencies, or a 503 that says which one is missing. */
export async function requirePipeline(): Promise<Pipeline> {
  const storage = await getObjectStorage();
  if (!storage) {
    const availability = await pipelineAvailability();
    throw new ApiError(503, "direct_uploads_unavailable", availability.available ? "Direct uploads are not available." : availability.message, {
      hint: "Use the standard upload, which accepts smaller files.",
    });
  }
  // A database failure surfaces as the existing `storage_unavailable` error with its category.
  const store = await pipelineStore();
  return { store, storage };
}

/** Maps a storage provider failure onto an API error with fixed wording. */
export function storageApiError(error: unknown): ApiError {
  if (error instanceof ObjectStorageError && error.code === "storage_misconfigured") {
    return new ApiError(503, "direct_uploads_unavailable", "Object storage rejected the request.", {
      hint: "Check that the storage token is valid and that the store is a private store.",
    });
  }
  return new ApiError(503, "storage_unavailable", "Object storage is temporarily unavailable.", { hint: "Try again in a moment." });
}

/* -------------------------------------------------------------------- views */

function itemView(item: ItemRecord, artifact: ArtifactRecord | undefined, now: number): ImageJobItem {
  const artifactAvailable = Boolean(artifact && artifact.deletedAt === null && artifact.availableUntil.getTime() > now);
  return {
    id: item._id,
    index: item.index,
    filename: item.filename,
    state: item.state,
    bytes: item.declaredBytes,
    attempts: item.attempts,
    errorCode: item.errorCode,
    message: item.message,
    retryable: item.state === "failed" && item.retryable && item.sourceStored,
    result: item.result
      ? {
          inputBytes: item.declaredBytes,
          outputBytes: item.result.outputBytes,
          savedBytes: item.result.savedBytes,
          savingsPercent: item.result.savingsPercent,
          inputWidth: item.result.inputWidth,
          inputHeight: item.result.inputHeight,
          outputWidth: item.result.outputWidth,
          outputHeight: item.result.outputHeight,
          outputFormat: item.result.outputFormat,
          outputFilename: item.result.outputFilename,
          durationMs: item.result.durationMs,
          retainedOriginal: item.result.retainedOriginal,
        }
      : null,
    artifactId: item.artifactId,
    artifactAvailable,
    artifactExpiresAt: artifact ? artifact.availableUntil.toISOString() : null,
  };
}

const count = (items: ItemRecord[], state: JobItemState): number => items.filter((item) => item.state === state).length;

/** Sums over the converted files. */
export function totalsOf(items: ItemRecord[]): { inputBytes: number; outputBytes: number; savedBytes: number; savingsPercent: number | null } {
  const done = items.filter((item) => item.state === "completed" && item.result);
  const inputBytes = done.reduce((sum, item) => sum + item.declaredBytes, 0);
  const outputBytes = done.reduce((sum, item) => sum + (item.result?.outputBytes ?? 0), 0);
  const savedBytes = inputBytes - outputBytes;
  return { inputBytes, outputBytes, savedBytes, savingsPercent: inputBytes > 0 ? Math.round((savedBytes / inputBytes) * 10_000) / 100 : null };
}

export function toJobView(job: JobRecord, items: ItemRecord[], artifacts: ArtifactRecord[]): ImageJob {
  const now = Date.now();
  const byId = new Map(artifacts.map((artifact) => [artifact._id, artifact]));
  return {
    id: job._id,
    state: job.state,
    settings: job.settings,
    cancelRequested: job.cancelRequested && !TERMINAL_STATES.includes(job.state),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    uploadedAt: job.uploadedAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    uploadDeadline: job.uploadDeadline.toISOString(),
    counts: {
      total: items.length,
      awaitingUpload: count(items, "awaiting_upload"),
      waiting: count(items, "uploaded"),
      processing: count(items, "processing"),
      completed: count(items, "completed"),
      failed: count(items, "failed"),
      cancelled: count(items, "cancelled"),
    },
    totals: totalsOf(items),
    items: items.map((item) => itemView(item, item.artifactId ? byId.get(item.artifactId) : undefined, now)),
  };
}

/** The copy of the items that is embedded in the job record for the History pages. */
export function snapshotItems(items: ItemRecord[], artifacts: ArtifactRecord[]): JobItemSnapshot[] {
  const now = Date.now();
  const available = new Set(artifacts.filter((artifact) => artifact.deletedAt === null && artifact.availableUntil.getTime() > now).map((artifact) => artifact._id));
  return items.map((item) => ({
    id: item._id,
    filename: item.filename,
    outputFilename: item.result?.outputFilename ?? null,
    status: item.state,
    inputBytes: item.declaredBytes,
    outputBytes: item.result?.outputBytes ?? 0,
    savedBytes: item.result?.savedBytes ?? 0,
    savingsPercent: item.result?.savingsPercent ?? null,
    inputWidth: item.result?.inputWidth ?? null,
    inputHeight: item.result?.inputHeight ?? null,
    outputWidth: item.result?.outputWidth ?? null,
    outputHeight: item.result?.outputHeight ?? null,
    outputFormat: item.result?.outputFormat ?? null,
    message: item.message,
    artifactId: item.artifactId && available.has(item.artifactId) ? item.artifactId : null,
  }));
}

export async function loadJobParts(store: PipelineStore, jobId: string): Promise<{ items: ItemRecord[]; artifacts: ArtifactRecord[] }> {
  const [items, artifacts] = await Promise.all([
    store.items.find({ jobId }, { sort: { index: 1 } }),
    store.artifacts.find({ jobId, storage: "object" }),
  ]);
  return { items, artifacts };
}

async function ownedJob(store: PipelineStore, sessionId: string, jobId: string): Promise<JobRecord> {
  const job = UUID.test(jobId) ? await store.jobs.findOne({ _id: jobId, sessionId, mode: "async" }) : null;
  if (!job) throw notFound("That job does not exist in this session.");
  return job;
}

async function viewOf(store: PipelineStore, job: JobRecord): Promise<ImageJob> {
  const { items, artifacts } = await loadJobParts(store, job._id);
  return toJobView(job, items, artifacts);
}

/* ----------------------------------------------------------------- creation */

export type CreateJobInput = {
  files: Array<{ name: string; type: string; size: number }>;
  settings: ImageOptimizeSettings;
  idempotencyKey?: string;
};

const mb = (bytes: number): string => (bytes / MB).toFixed(bytes % MB === 0 ? 0 : 1);

/**
 * Admits a job: checks the batch against every limit, takes one of the
 * session's job slots and reserves the storage the uploads will need. Nothing
 * is uploaded yet. Returns the existing job when the idempotency key was used
 * before.
 */
export async function createImageJob(sessionId: string, input: CreateJobInput): Promise<{ job: ImageJob; replayed: boolean }> {
  const { store } = await requirePipeline();

  if (input.files.length > capacity.maxFiles) {
    throw tooManyFiles(`A job accepts at most ${capacity.maxFiles} files; this one has ${input.files.length}.`, "Split the batch into smaller jobs.");
  }
  const files = input.files.map((file) => {
    const filename = sanitizeFilename(file.name);
    const contentType = rasterContentType(file.name, file.type);
    if (!contentType) throw unsupportedMedia(`"${filename}" is not a supported image type.`, "Upload JPEG, PNG, WebP, AVIF, GIF or TIFF files.");
    if (file.size > capacity.maxFileBytes) {
      throw payloadTooLarge(`"${filename}" is ${mb(file.size)} MB, above the ${mb(capacity.maxFileBytes)} MB limit per file.`, "Downscale or re-export the image, then upload again.");
    }
    return { filename, contentType, bytes: file.size };
  });
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes > capacity.maxBatchBytes) {
    throw payloadTooLarge(`This batch is ${mb(totalBytes)} MB, above the ${mb(capacity.maxBatchBytes)} MB limit per job.`, "Send fewer or smaller files per job.");
  }

  const jobId = input.idempotencyKey ? stableUuid("job", sessionId, input.idempotencyKey) : randomUUID();
  if (input.idempotencyKey) {
    const existing = await store.jobs.findOne({ _id: jobId, sessionId, mode: "async" });
    if (existing) return { job: await viewOf(store, existing), replayed: true };
  }

  // Admission. Each step is one conditional update, so concurrent requests cannot both pass a limit.
  if (!(await acquireJobSlot(sessionId))) {
    // The counter can be stale after an interrupted request. Recount once before refusing.
    await reconcileSession(sessionId);
    if (!(await acquireJobSlot(sessionId))) {
      throw new ApiError(429, "too_many_active_jobs", `This session already has ${capacity.maxActiveJobs} unfinished jobs.`, {
        hint: "Wait for a job to finish, or cancel one, then try again.",
      });
    }
  }
  const reservation = await reserveUploadBytes(sessionId, totalBytes);
  if (!reservation.ok) {
    await releaseJobSlot(sessionId, false);
    if (reservation.reason === "session_quota") {
      throw new ApiError(403, "quota_exceeded", `These files need ${mb(totalBytes)} MB, which does not fit in this session's ${mb(capacity.sessionQuotaBytes)} MB of storage.`, {
        hint: "Delete jobs you no longer need in History, or wait for stored files to expire.",
      });
    }
    throw new ApiError(503, "capacity_exhausted", "The service has reached its upload capacity for now.", { hint: "Please try again later." });
  }

  const now = new Date();
  const expireAt = new Date(now.getTime() + capacity.historyTtlMs);
  const items: ItemRecord[] = files.map((file, index) => {
    const id = randomUUID();
    return {
      _id: id,
      jobId,
      sessionId,
      index,
      filename: file.filename,
      contentType: file.contentType,
      declaredBytes: file.bytes,
      path: sourcePath(sessionId, jobId, id, file.filename),
      state: "awaiting_upload",
      sourceStored: false,
      heldBytes: file.bytes,
      holdKind: "reservation",
      attempts: 0,
      errorCode: null,
      message: null,
      retryable: false,
      result: null,
      artifactId: null,
      createdAt: now,
      uploadedAt: null,
      finishedAt: null,
      purgeSourceAt: null,
      expireAt,
    };
  });
  const job: JobRecord = {
    _id: jobId,
    sessionId,
    kind: "image.optimize",
    status: "created",
    label: files.length === 1 ? files[0].filename : `${files.length} images`,
    fileCount: files.length,
    inputBytes: totalBytes,
    outputBytes: 0,
    savedBytes: 0,
    note: null,
    items: snapshotItems(items, []),
    createdAt: now,
    mode: "async",
    state: "created",
    settings: input.settings,
    updatedAt: now,
    uploadedAt: null,
    queuedAt: null,
    startedAt: null,
    finishedAt: null,
    leaseOwner: null,
    leaseUntil: null,
    claims: 0,
    cancelRequested: false,
    pixelsUsed: 0,
    slotReleased: false,
    uploadDeadline: new Date(now.getTime() + capacity.uploadPhaseTtlMs),
    expireAt,
  };

  try {
    await store.jobs.insertOne(job);
  } catch (error) {
    await Promise.all([releaseReservation(sessionId, totalBytes), releaseJobSlot(sessionId, false)]);
    if (isDuplicateKey(error)) {
      // A concurrent request with the same idempotency key created the job first.
      const existing = await store.jobs.findOne({ _id: jobId, sessionId, mode: "async" });
      if (existing) return { job: await viewOf(store, existing), replayed: true };
    }
    throw error;
  }
  try {
    for (const item of items) await store.items.insertOne(item);
  } catch (error) {
    await Promise.all([store.items.deleteMany({ jobId }), store.jobs.deleteOne({ _id: jobId }), releaseReservation(sessionId, totalBytes), releaseJobSlot(sessionId, false)]);
    throw error;
  }
  void recordDay({ jobs: 1 });
  return { job: toJobView(job, items, []), replayed: false };
}

/* ------------------------------------------------------------------ uploads */

async function ownedItem(store: PipelineStore, sessionId: string, uploadId: string): Promise<{ item: ItemRecord; job: JobRecord }> {
  const item = UUID.test(uploadId) ? await store.items.findOne({ _id: uploadId, sessionId }) : null;
  const job = item ? await store.jobs.findOne({ _id: item.jobId, sessionId, mode: "async" }) : null;
  if (!item || !job) throw notFound("That upload does not exist in this session.");
  return { item, job };
}

/**
 * Authorizes the browser to upload one file of a job straight to storage. The
 * grant is bound to the server-generated path, the declared size and content
 * type, and a short validity. It can be requested again, for example to retry
 * a failed upload; each grant is for the same path.
 */
export async function issueUploadGrant(sessionId: string, uploadId: string): Promise<UploadGrantView> {
  const { store, storage } = await requirePipeline();
  const { item, job } = await ownedItem(store, sessionId, uploadId);
  if (item.state !== "awaiting_upload") throw conflict("This file has already been uploaded or removed.");
  const now = Date.now();
  if (!UPLOAD_PHASE.includes(job.state) || job.uploadDeadline.getTime() <= now) {
    throw conflict("This job no longer accepts uploads.", "Start a new job.");
  }
  const validUntil = Math.min(now + capacity.uploadTokenTtlMs, job.uploadDeadline.getTime());
  let grant;
  try {
    grant = await storage.authorizeUpload({
      uploadId: item._id,
      path: item.path,
      contentType: item.contentType,
      maxBytes: item.declaredBytes,
      validUntil,
      ttlDays: storageTtlDays.source(),
    });
  } catch (error) {
    throw storageApiError(error);
  }
  await store.jobs.updateOne({ _id: job._id, state: "created" }, { $set: { state: "uploading", status: "uploading", updatedAt: new Date() } });
  return { uploadId: item._id, contentType: item.contentType, bytes: item.declaredBytes, expiresAt: new Date(validUntil).toISOString(), ...grant };
}

/** Marks an item as failed during the upload phase and gives back what it held. */
async function rejectUpload(pipeline: Pipeline, item: ItemRecord, errorCode: string, message: string): Promise<void> {
  const { store, storage } = pipeline;
  const changed = await store.items.updateOne(
    { _id: item._id, state: "awaiting_upload" },
    { $set: { state: "failed", errorCode, message, retryable: false, sourceStored: false, holdKind: "none", heldBytes: 0, finishedAt: new Date() } },
  );
  if (changed.modified === 1) await releaseReservation(item.sessionId, item.declaredBytes);
  await storage.remove([item.path]).catch(() => undefined);
}

/**
 * Hands a job to the worker once none of its files is still awaiting upload.
 * Returns true when this call queued it. Safe to call any number of times.
 */
export async function queueIfReady(store: PipelineStore, jobId: string): Promise<boolean> {
  if ((await store.items.countDocuments({ jobId, state: "awaiting_upload" })) > 0) return false;
  const now = new Date();
  const uploaded = await store.jobs.updateOne({ _id: jobId, state: { $in: UPLOAD_PHASE } }, { $set: { state: "uploaded", status: "uploaded", uploadedAt: now, updatedAt: now } });
  // `uploaded` is promoted in a second step. If this process stops in between,
  // the next status request or the sweep promotes it.
  const queued = await store.jobs.updateOne({ _id: jobId, state: "uploaded" }, { $set: { state: "queued", status: "queued", queuedAt: now, updatedAt: now } });
  if (queued.modified === 1) kickWorker();
  return uploaded.modified === 1 || queued.modified === 1;
}

/**
 * Confirms that a file has arrived. Nothing the browser says is trusted: the
 * object is looked up in storage at the server-generated path, its size must
 * be the declared size, and its first bytes must be a supported image
 * signature. A file that fails is deleted. Calling this again for the same
 * file changes nothing.
 */
/**
 * Checks one awaited file against storage and records the outcome. Returns
 * `absent` when the object is not there (yet). Storage errors are thrown.
 */
export async function verifyArrival(pipeline: Pipeline, item: ItemRecord): Promise<"accepted" | "rejected" | "absent"> {
  const { store, storage } = pipeline;
  const found = await storage.head(item.path);
  if (!found) return "absent";
  if (found.bytes !== item.declaredBytes) {
    await rejectUpload(pipeline, item, "size_mismatch", `"${item.filename}" arrived with ${found.bytes.toLocaleString()} bytes instead of the declared ${item.declaredBytes.toLocaleString()}.`);
    return "rejected";
  }
  const reader = await storage.read(item.path);
  const signature = reader ? sniffSignature(await readHead(reader, SIGNATURE_BYTES)) : null;
  if (!signature) {
    await rejectUpload(pipeline, item, "unsupported_media_type", `"${item.filename}" is not a JPEG, PNG, WebP, AVIF, GIF or TIFF file.`);
    return "rejected";
  }
  const accepted = await store.items.updateOne(
    { _id: item._id, state: "awaiting_upload" },
    { $set: { state: "uploaded", uploadedAt: new Date(), sourceStored: true, holdKind: "source", heldBytes: found.bytes } },
  );
  // Only the call that changed the state moves the counters, so a repeated confirmation is not counted twice.
  if (accepted.modified === 1) {
    await settleUpload(item.sessionId, item.declaredBytes, found.bytes);
    void recordDay({ uploads: 1 });
  }
  return "accepted";
}

export async function completeUpload(sessionId: string, uploadId: string): Promise<{ job: ImageJob; queued: boolean }> {
  const pipeline = await requirePipeline();
  const { store } = pipeline;
  const { item, job } = await ownedItem(store, sessionId, uploadId);

  if (item.state === "awaiting_upload") {
    if (!UPLOAD_PHASE.includes(job.state)) throw conflict("This job no longer accepts uploads.", "Start a new job.");
    let arrival;
    try {
      arrival = await verifyArrival(pipeline, item);
    } catch (error) {
      if (isDatabaseError(error)) throw error;
      throw storageApiError(error);
    }
    if (arrival === "absent") throw conflict("The file has not arrived in storage.", "Upload the file, then confirm it again.");
  }

  const queued = await queueIfReady(store, job._id);
  const current = (await store.jobs.findOne({ _id: job._id })) ?? job;
  return { job: await viewOf(store, current), queued };
}

/**
 * Removes one file from a job that is still collecting uploads. Its storage
 * object is deleted and its share of the quota is given back.
 */
export async function removeUpload(sessionId: string, uploadId: string): Promise<ImageJob> {
  const pipeline = await requirePipeline();
  const { store, storage } = pipeline;
  const { item, job } = await ownedItem(store, sessionId, uploadId);
  if (!UPLOAD_PHASE.includes(job.state)) throw conflict("Files can only be removed while the job is still uploading.", "Cancel the job instead.");
  if (item.state === "awaiting_upload" || item.state === "uploaded") {
    const removed = await store.items.updateOne(
      { _id: item._id, state: item.state },
      { $set: { state: "cancelled", errorCode: "removed", message: "Removed before processing.", retryable: false, sourceStored: false, holdKind: "none", heldBytes: 0, finishedAt: new Date() } },
    );
    if (removed.modified === 1) {
      await (item.holdKind === "source" ? releaseSource(sessionId, item.heldBytes) : releaseReservation(sessionId, item.heldBytes));
    }
    await storage.remove([item.path]).catch(() => undefined);
  }
  await queueIfReady(store, job._id);
  return viewOf(store, (await store.jobs.findOne({ _id: job._id })) ?? job);
}

/* ------------------------------------------------------------------- status */

/**
 * The job as it is now. Reading a job also nudges it: a job that is ready but
 * has no live worker is handed to one, so a job whose worker died resumes as
 * soon as anyone looks at it.
 */
export async function getImageJob(sessionId: string, jobId: string): Promise<ImageJob> {
  const { store } = await requirePipeline();
  const job = await ownedJob(store, sessionId, jobId);
  const leaseLive = job.leaseUntil !== null && job.leaseUntil.getTime() > Date.now();
  if (job.state === "uploaded" || UPLOAD_PHASE.includes(job.state)) {
    await queueIfReady(store, job._id);
  } else if ((job.state === "queued" || job.state === "processing") && !leaseLive) {
    kickWorker();
  }
  return viewOf(store, (await store.jobs.findOne({ _id: job._id })) ?? job);
}

/* ------------------------------------------------------------------ control */

/**
 * Requests cancellation. A job that no worker holds is cancelled at once. A
 * job that is being processed stops after the file in progress; files that
 * were already converted stay available.
 */
export async function cancelImageJob(sessionId: string, jobId: string): Promise<ImageJob> {
  const { store } = await requirePipeline();
  const job = await ownedJob(store, sessionId, jobId);
  if (!TERMINAL_STATES.includes(job.state)) {
    await store.jobs.updateOne({ _id: job._id, state: { $in: ACTIVE_STATES } }, { $set: { cancelRequested: true, updatedAt: new Date() } });
    const { finishCancelledJob } = await import("./worker.js");
    await finishCancelledJob(job._id);
  }
  return viewOf(store, (await store.jobs.findOne({ _id: job._id })) ?? job);
}

/**
 * Runs the failed files of a finished job again. Only files whose failure was
 * temporary and whose source is still stored are retried; an invalid image is
 * not processed a second time.
 */
export async function retryImageJob(sessionId: string, jobId: string): Promise<ImageJob> {
  const { store } = await requirePipeline();
  const job = await ownedJob(store, sessionId, jobId);
  if (job.state !== "partial" && job.state !== "failed") {
    throw conflict(TERMINAL_STATES.includes(job.state) ? "This job has no failed files to retry." : "This job is still running.");
  }
  const eligible = await store.items.find({ jobId: job._id, state: "failed", retryable: true, sourceStored: true });
  if (eligible.length === 0) {
    throw conflict("None of the failed files can be retried.", "Their failures were not temporary, or their source files have been deleted. Upload them again in a new job.");
  }
  if (!(await acquireJobSlot(sessionId))) {
    await reconcileSession(sessionId);
    if (!(await acquireJobSlot(sessionId))) {
      throw new ApiError(429, "too_many_active_jobs", `This session already has ${capacity.maxActiveJobs} unfinished jobs.`, { hint: "Wait for a job to finish, then retry." });
    }
  }
  const now = new Date();
  const reopened = await store.jobs.updateOne(
    { _id: job._id, state: { $in: ["partial", "failed"] } },
    { $set: { state: "queued", status: "queued", queuedAt: now, finishedAt: null, cancelRequested: false, slotReleased: false, leaseOwner: null, leaseUntil: null, updatedAt: now } },
  );
  if (reopened.modified === 0) {
    // Another request reopened the job first; give the extra slot back.
    await releaseJobSlot(sessionId, false);
  } else {
    await store.items.updateMany(
      { jobId: job._id, state: "failed", retryable: true, sourceStored: true },
      { $set: { state: "uploaded", attempts: 0, errorCode: null, message: null, retryable: false, finishedAt: null, purgeSourceAt: null } },
    );
    kickWorker();
  }
  return viewOf(store, (await store.jobs.findOne({ _id: job._id })) ?? job);
}

/** Whether an error means the database is unavailable. Such an error is rethrown, never recorded as an item failure. */
export const isDatabaseError = (error: unknown): boolean => error instanceof StorageUnavailableError;
