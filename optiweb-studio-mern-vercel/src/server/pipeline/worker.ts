/**
 * The worker: takes queued jobs and converts their files.
 *
 * Durability comes from the job record, not from this process:
 *
 *  - Claim. A worker takes a job with one conditional update that sets a lease
 *    (owner and expiry). Only one worker can win it.
 *  - Heartbeat. While it works, the worker extends the lease. Every write that
 *    matters is conditional on still owning it.
 *  - Recovery. If the worker dies, the lease lapses and any later worker run
 *    claims the job again. Files that were finished stay finished; the file
 *    that was in progress is started again, and its attempt was counted before
 *    it began, so a file that keeps killing the worker is given up on after a
 *    bounded number of attempts.
 *  - Idempotency. A file's output has a fixed storage path and a fixed
 *    artifact ID. Processing it twice overwrites; it never duplicates.
 *
 * Files are processed one at a time. At most one image is decoded in this
 * process at any moment, whatever the number of concurrent invocations.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { crc32 } from "node:zlib";
import { capacity } from "../config/env.js";
import { ApiError } from "../http/errors.js";
import { optimizeWithPolicy, sniffImage, type ImageBudget } from "../services/imageService.js";
import { artifactPath } from "../storage/objectPaths.js";
import { ObjectStorageError, getObjectStorage, readAll, storageTtlDays, type ObjectStorage } from "../storage/objectStorage.js";
import { stableUuid } from "./ids.js";
import { ACTIVE_STATES, isDatabaseError, loadJobParts, snapshotItems, totalsOf } from "./jobs.js";
import { pipelineStore, type ArtifactRecord, type ItemRecord, type ItemResult, type JobRecord, type PipelineStore } from "./store.js";
import { recordDay, recordJob, recordOutput, releaseArtifact, releaseJobSlot, releaseReservation, releaseSource, reserveArtifactBytes } from "./usage.js";
import type { JobState } from "../../types/domain.js";

const PROCESS_ID = randomUUID().slice(0, 8);
let runCounter = 0;

/** Limits of one image inside a job. */
const jobBudget = (): ImageBudget => ({
  maxFileBytes: capacity.maxFileBytes,
  maxDecodedPixels: capacity.maxDecodedPixels,
  timeoutMs: capacity.imageTimeoutMs,
  avifCandidateMaxPixels: capacity.avifCandidateMaxPixels,
  avifMaxPixels: capacity.avifMaxPixels,
});

/** Serialises image work in this process: decoded pixels are the memory risk, so only one image is open at a time. */
let gate: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = gate.then(task, task);
  gate = run.catch(() => undefined);
  return run;
}

export type DrainReport = {
  /** Jobs this run claimed. */
  claimed: number;
  /** Jobs this run brought to a final state. */
  finished: number;
  /** Jobs put back because the time budget ran out. */
  yielded: number;
  /** Jobs whose lease was lost to another worker. */
  lost: number;
  itemsCompleted: number;
  itemsFailed: number;
  itemsRetried: number;
};

type ItemFailure = { errorCode: string; message: string; retryable: boolean };

/** A failure that is the file's fault or the configuration's, with wording that is safe to show. */
class ItemError extends Error {
  readonly failure: ItemFailure;
  constructor(failure: ItemFailure) {
    super(failure.errorCode);
    this.failure = failure;
  }
}

function classify(error: unknown): ItemFailure {
  if (error instanceof ItemError) return error.failure;
  // The image service reports invalid input with fixed, user-facing wording. Such a file fails the same way every time.
  if (error instanceof ApiError) return { errorCode: error.code, message: error.message, retryable: false };
  if (error instanceof ObjectStorageError) {
    return error.retryable
      ? { errorCode: "storage_unavailable", message: "Object storage was temporarily unavailable.", retryable: true }
      : { errorCode: error.code, message: "Object storage rejected the request.", retryable: false };
  }
  return { errorCode: "processing_failed", message: "The file could not be processed.", retryable: true };
}

/* -------------------------------------------------------------------- lease */

const leaseExpired = (now: Date) => ({ $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] });
const leaseEnd = (): Date => new Date(Date.now() + capacity.jobLeaseMs);

async function claimNextJob(store: PipelineStore, owner: string): Promise<JobRecord | null> {
  const now = new Date();
  const job = await store.jobs.findOneAndUpdate(
    { mode: "async", state: { $in: ["queued", "processing"] }, ...leaseExpired(now) },
    { $set: { state: "processing", status: "processing", leaseOwner: owner, leaseUntil: leaseEnd(), updatedAt: now }, $inc: { claims: 1 } },
    { sort: { queuedAt: 1 }, returnDocument: "after" },
  );
  if (job && job.startedAt === null) await store.jobs.updateOne({ _id: job._id, startedAt: null }, { $set: { startedAt: now } });
  return job;
}

/** Extends the lease. Returns the current record, or null when another worker owns the job now. */
function renewLease(store: PipelineStore, jobId: string, owner: string): Promise<JobRecord | null> {
  return store.jobs.findOneAndUpdate({ _id: jobId, leaseOwner: owner }, { $set: { leaseUntil: leaseEnd() } }, { returnDocument: "after" });
}

/** Keeps the lease alive while one file is being processed. */
function heartbeat(store: PipelineStore, jobId: string, owner: string): { stop: () => void } {
  const timer = setInterval(() => {
    void renewLease(store, jobId, owner).catch(() => undefined);
  }, Math.max(5_000, Math.floor(capacity.jobLeaseMs / 3)));
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/* -------------------------------------------------------------------- items */

async function failItem(store: PipelineStore, item: ItemRecord, failure: ItemFailure): Promise<void> {
  await store.items.updateOne(
    { _id: item._id },
    { $set: { state: "failed", errorCode: failure.errorCode, message: failure.message, retryable: failure.retryable, finishedAt: new Date() } },
  );
}

/**
 * Converts one file. Returns what happened to it; a database failure is
 * thrown, because then nothing can be recorded and the lease must lapse.
 */
async function processItem(store: PipelineStore, storage: ObjectStorage, job: JobRecord, item: ItemRecord, pixelsUsed: number): Promise<{ outcome: "completed" | "failed" | "retry"; pixels: number }> {
  const attempts = item.attempts + 1;
  if (attempts > capacity.maxItemRetries + 1) {
    await failItem(store, item, { errorCode: "retry_exhausted", message: `Processing was stopped after ${capacity.maxItemRetries + 1} attempts.`, retryable: true });
    return { outcome: "failed", pixels: 0 };
  }
  // The attempt is recorded before the work starts, so an attempt that kills the worker still counts.
  await store.items.updateOne({ _id: item._id }, { $set: { state: "processing", attempts, errorCode: null, message: null } });

  const started = Date.now();
  const budget = jobBudget();
  try {
    const result = await exclusive(async () => {
      const reader = await storage.read(item.path);
      if (!reader) throw new ItemError({ errorCode: "source_missing", message: "The uploaded file is no longer in storage.", retryable: false });
      const source = await readAll(reader, capacity.maxFileBytes);
      if (source.byteLength !== item.declaredBytes) {
        throw new ItemError({ errorCode: "source_changed", message: "The uploaded file changed after it was confirmed.", retryable: false });
      }

      // Decoded size is read from the header, before any pixel is decoded.
      const sniffed = await sniffImage(source);
      const pixels = (sniffed.width ?? 0) * (sniffed.height ?? 0) * Math.max(1, sniffed.pages);
      if (pixels > capacity.maxDecodedPixels) {
        throw new ItemError({
          errorCode: "payload_too_large",
          message: `"${item.filename}" decodes to ${pixels.toLocaleString("en-US")} pixels, above the ${capacity.maxDecodedPixels.toLocaleString("en-US")} pixel limit per image.`,
          retryable: false,
        });
      }
      if (pixelsUsed + pixels > capacity.maxJobPixels) {
        throw new ItemError({
          errorCode: "job_pixel_budget_exceeded",
          message: `This image would bring the job to ${Math.round((pixelsUsed + pixels) / 1_000_000)} MP, above the ${Math.round(capacity.maxJobPixels / 1_000_000)} MP limit per job.`,
          retryable: false,
        });
      }

      const outcome = await optimizeWithPolicy({ filename: item.filename, buffer: source, settings: job.settings, budget });
      if (outcome.output.byteLength > capacity.maxArtifactBytes) {
        throw new ItemError({
          errorCode: "output_too_large",
          message: `The generated file is ${(outcome.output.byteLength / 1024 / 1024).toFixed(1)} MB, above the ${Math.round(capacity.maxArtifactBytes / 1024 / 1024)} MB limit.`,
          retryable: false,
        });
      }
      return { outcome, pixels };
    });
    const { outcome, pixels } = result;
    const bytes = outcome.output.byteLength;

    // Fixed ID and path: processing this file again replaces its output.
    const artifactId = stableUuid("artifact", job._id, item._id);
    const existing = await store.artifacts.findOne({ _id: artifactId });
    const replaced = existing && existing.deletedAt === null ? existing.byteSize : 0;
    if (!(await reserveArtifactBytes(job.sessionId, bytes, replaced))) {
      throw new ItemError({ errorCode: "quota_exceeded", message: "The generated file does not fit in this session's storage quota.", retryable: true });
    }
    const path = artifactPath(job.sessionId, job._id, item._id, outcome.filename);
    try {
      await storage.write(path, outcome.output, { contentType: outcome.contentType, ttlDays: storageTtlDays.artifact() });
    } catch (error) {
      await releaseArtifact(job.sessionId, bytes - replaced);
      throw error;
    }
    const now = new Date();
    const record: Omit<ArtifactRecord, "_id"> = {
      jobId: job._id,
      sessionId: job.sessionId,
      itemId: item._id,
      filename: outcome.filename,
      itemFilename: item.filename,
      contentType: outcome.contentType,
      byteSize: bytes,
      crc32: crc32(outcome.output) >>> 0,
      kind: "image",
      storage: "object",
      path,
      createdAt: now,
      availableUntil: new Date(now.getTime() + capacity.artifactTtlMs),
      deletedAt: null,
      expireAt: job.expireAt,
    };
    await store.artifacts.updateOne({ _id: artifactId }, { $set: record }, { upsert: true });

    const itemResult: ItemResult = {
      outputFilename: outcome.filename,
      outputBytes: bytes,
      savedBytes: outcome.metrics.savedBytes,
      savingsPercent: outcome.metrics.savingsPercent,
      inputWidth: outcome.metrics.inputWidth,
      inputHeight: outcome.metrics.inputHeight,
      outputWidth: outcome.metrics.outputWidth,
      outputHeight: outcome.metrics.outputHeight,
      outputFormat: outcome.metrics.outputFormat,
      durationMs: Date.now() - started,
      retainedOriginal: outcome.retainedOriginal,
      pixels,
    };
    await store.items.updateOne({ _id: item._id }, { $set: { state: "completed", result: itemResult, artifactId, errorCode: null, message: null, retryable: false, finishedAt: now } });
    await recordOutput(job.sessionId, bytes);
    void recordDay({ transforms: 1, transformMs: itemResult.durationMs, outputBytes: bytes });
    return { outcome: "completed", pixels };
  } catch (error) {
    if (isDatabaseError(error)) throw error;
    const failure = classify(error);
    if (failure.retryable && attempts <= capacity.maxItemRetries) {
      // Back to waiting; the loop picks it up again after a short pause.
      await store.items.updateOne({ _id: item._id }, { $set: { state: "uploaded", errorCode: failure.errorCode, message: failure.message } });
      void recordDay({ retries: 1 });
      return { outcome: "retry", pixels: 0 };
    }
    await failItem(store, item, failure);
    void recordDay({ failures: 1 });
    return { outcome: "failed", pixels: 0 };
  }
}

/** Stops every file of a job that has not finished: cancels it, gives back its quota and deletes its source. */
async function cancelRemaining(store: PipelineStore, storage: ObjectStorage | null, job: JobRecord): Promise<void> {
  const open = await store.items.find({ jobId: job._id, state: { $in: ["awaiting_upload", "uploaded", "processing"] } });
  for (const item of open) {
    const changed = await store.items.updateOne(
      { _id: item._id, state: item.state },
      { $set: { state: "cancelled", errorCode: "cancelled", message: "Cancelled before processing.", retryable: false, sourceStored: false, holdKind: "none", heldBytes: 0, finishedAt: new Date() } },
    );
    if (changed.modified !== 1) continue;
    if (item.holdKind === "source") await releaseSource(job.sessionId, item.heldBytes);
    else if (item.holdKind === "reservation") await releaseReservation(job.sessionId, item.heldBytes);
  }
  if (storage && open.length > 0) await storage.remove(open.map((item) => item.path)).catch(() => undefined);
}

/* ----------------------------------------------------------------- finalize */

/** The final state that the files' states add up to. */
function finalState(items: ItemRecord[]): JobState {
  // A file the user removed before processing is not part of the job any more.
  const counted = items.filter((item) => !(item.state === "cancelled" && item.errorCode === "removed"));
  if (counted.length === 0 || counted.some((item) => item.state === "cancelled")) return "cancelled";
  const completed = counted.filter((item) => item.state === "completed").length;
  if (completed === counted.length) return "completed";
  return completed > 0 ? "partial" : "failed";
}

/**
 * Closes a job the caller owns: records the final state and totals, schedules
 * the source files for deletion and gives the session's job slot back once.
 */
async function finalizeJob(store: PipelineStore, jobId: string, owner: string): Promise<boolean> {
  const { items, artifacts } = await loadJobParts(store, jobId);
  const state = finalState(items);
  const totals = totalsOf(items);
  const now = new Date();
  const failed = items.filter((item) => item.state === "failed").length;
  const closed = await store.jobs.findOneAndUpdate(
    { _id: jobId, leaseOwner: owner },
    {
      $set: {
        state,
        status: state,
        finishedAt: now,
        updatedAt: now,
        leaseOwner: null,
        leaseUntil: null,
        inputBytes: totals.inputBytes,
        outputBytes: totals.outputBytes,
        savedBytes: totals.savedBytes,
        items: snapshotItems(items, artifacts),
        note: failed > 0 ? `${failed} file${failed === 1 ? "" : "s"} could not be converted` : null,
      },
    },
    { returnDocument: "after" },
  );
  if (!closed) return false;
  // Sources are kept for a while so that failed files can be retried, then deleted by the cleanup routine.
  await store.items.updateMany({ jobId, sourceStored: true }, { $set: { purgeSourceAt: new Date(now.getTime() + capacity.sourceTtlMs) } });
  // Deleting the slot is idempotent, so a repeated finalisation cannot free a slot twice.
  await releaseJobSlot(closed.sessionId, jobId);
  if (state === "failed") await recordJob(closed.sessionId, true);
  return true;
}

/**
 * Cancels a job whose cancellation was requested, if no worker holds it. A
 * job that a worker holds is cancelled by that worker after its current file.
 */
export async function finishCancelledJob(jobId: string): Promise<void> {
  const store = await pipelineStore();
  const owner = `${PROCESS_ID}:cancel:${(runCounter += 1)}`;
  const now = new Date();
  const job = await store.jobs.findOneAndUpdate(
    { _id: jobId, cancelRequested: true, state: { $in: ACTIVE_STATES }, ...leaseExpired(now) },
    { $set: { leaseOwner: owner, leaseUntil: leaseEnd(), updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!job) return;
  await cancelRemaining(store, await getObjectStorage(), job);
  await finalizeJob(store, job._id, owner);
}

/* --------------------------------------------------------------------- loop */

/** Processes one claimed job until it is finished, cancelled, lost, or the time budget runs out. */
async function runJob(store: PipelineStore, storage: ObjectStorage, claimed: JobRecord, owner: string, deadline: number, report: DrainReport): Promise<void> {
  let pixelsUsed = claimed.pixelsUsed;
  // Time one more file may need. A file is not started with less than this left.
  const reserveMs = Math.min(capacity.imageTimeoutMs, 45_000);
  for (;;) {
    const job = await renewLease(store, claimed._id, owner);
    if (!job) {
      report.lost += 1;
      return;
    }
    if (job.cancelRequested) {
      await cancelRemaining(store, storage, job);
      break;
    }
    const item = await store.items.findOne({ jobId: job._id, state: { $in: ["uploaded", "processing"] } }, { sort: { index: 1 } });
    if (!item) break;
    if (Date.now() + reserveMs > deadline) {
      // Out of time: put the job back for the next worker run.
      await store.jobs.updateOne({ _id: job._id, leaseOwner: owner }, { $set: { state: "queued", status: "queued", leaseOwner: null, leaseUntil: null, updatedAt: new Date() } });
      report.yielded += 1;
      return;
    }
    const beat = heartbeat(store, job._id, owner);
    let result;
    try {
      result = await processItem(store, storage, job, item, pixelsUsed);
    } finally {
      beat.stop();
    }
    if (result.outcome === "completed") {
      report.itemsCompleted += 1;
      pixelsUsed += result.pixels;
      await store.jobs.updateOne({ _id: job._id, leaseOwner: owner }, { $set: { pixelsUsed, updatedAt: new Date() } });
    } else if (result.outcome === "failed") {
      report.itemsFailed += 1;
    } else {
      report.itemsRetried += 1;
      await delay(Math.min(2_000, 250 * (item.attempts + 1)));
    }
  }
  if (await finalizeJob(store, claimed._id, owner)) report.finished += 1;
  else report.lost += 1;
}

/**
 * One worker run: claims queued jobs, oldest first, and processes them until
 * none is left or the time budget is used up. Safe to run concurrently, in
 * this process or in others.
 */
export async function drainJobs(options: { budgetMs?: number; maxJobs?: number } = {}): Promise<DrainReport> {
  const report: DrainReport = { claimed: 0, finished: 0, yielded: 0, lost: 0, itemsCompleted: 0, itemsFailed: 0, itemsRetried: 0 };
  const storage = await getObjectStorage();
  if (!storage) return report;
  const store = await pipelineStore();
  const owner = `${PROCESS_ID}:${(runCounter += 1)}`;
  const deadline = Date.now() + (options.budgetMs ?? capacity.workerBudgetMs);
  const maxJobs = options.maxJobs ?? 50;
  while (report.claimed < maxJobs && Date.now() < deadline) {
    const job = await claimNextJob(store, owner);
    if (!job) break;
    report.claimed += 1;
    await runJob(store, storage, job, owner, deadline, report);
    if (report.yielded > 0) break;
  }
  return report;
}
