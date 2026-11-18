/**
 * Retention and repair, run on a schedule.
 *
 * MongoDB's TTL indexes delete records, not objects in storage. This routine
 * deletes the objects, while the record that names their owner still exists:
 *
 *  - source uploads, some hours after their job finished;
 *  - generated files, after their retention period.
 *
 * It also repairs what an interrupted request can leave behind: an upload that
 * arrived but was never confirmed, a job whose uploads never finished, a job
 * whose worker died, and counters that drifted.
 *
 * Every step is safe to repeat. An object is deleted before its record is
 * marked, so a failed deletion is simply tried again by the next run, and a
 * counter moves only when a record changes state. A record is only ever used
 * to delete an object inside its own session's storage area.
 */
import { capacity } from "../config/env.js";
import { isOwnedPath } from "../storage/objectPaths.js";
import { getObjectStorage } from "../storage/objectStorage.js";
import { loadJobParts, queueIfReady, snapshotItems, verifyArrival } from "./jobs.js";
import { pipelineStore, type PipelineStore } from "./store.js";
import { reconcileGlobal, reconcileSession, releaseArtifact, releaseSource } from "./usage.js";
import { drainJobs, finishCancelledJob, type DrainReport } from "./worker.js";

export type CleanupReport = {
  /** Uploads that had arrived in storage without being confirmed, and were accepted now. */
  uploadsRecovered: number;
  /** Jobs cancelled because their uploads never finished. */
  jobsAbandoned: number;
  /** Jobs handed back to the worker. */
  jobsRequeued: number;
  sourcesDeleted: number;
  artifactsDeleted: number;
  /** Objects whose deletion failed; the next run tries them again. */
  deleteFailures: number;
  sessionsReconciled: number;
  worker: DrainReport | null;
};

const BATCH = 200;

/** Embeds the current state of a job's files in the job record, for the History pages. */
export async function refreshJobSnapshot(store: PipelineStore, jobId: string): Promise<void> {
  const { items, artifacts } = await loadJobParts(store, jobId);
  await store.jobs.updateOne({ _id: jobId, mode: "async" }, { $set: { items: snapshotItems(items, artifacts) } });
}

export async function runCleanup(options: { now?: Date; workerBudgetMs?: number } = {}): Promise<CleanupReport> {
  const report: CleanupReport = { uploadsRecovered: 0, jobsAbandoned: 0, jobsRequeued: 0, sourcesDeleted: 0, artifactsDeleted: 0, deleteFailures: 0, sessionsReconciled: 0, worker: null };
  const storage = await getObjectStorage();
  if (!storage) return report;
  const store = await pipelineStore();
  const now = options.now ?? new Date();
  const touched = new Set<string>();

  /* 1. Jobs still in their upload phase. */
  const settleBefore = new Date(now.getTime() - 5 * 60_000);
  // A record that was never admitted belongs to a request that died half-way. It holds nothing that was counted.
  const unadmitted = await store.jobs.find({ mode: "async", admitted: false, createdAt: { $lt: settleBefore } }, { limit: BATCH });
  for (const job of unadmitted) {
    await Promise.all([store.items.deleteMany({ jobId: job._id }), store.slots.deleteMany({ jobId: job._id }), store.jobs.deleteOne({ _id: job._id, admitted: false })]);
    touched.add(job.sessionId);
    report.jobsAbandoned += 1;
  }
  const uploading = await store.jobs.find({ mode: "async", admitted: true, state: { $in: ["created", "uploading"] }, createdAt: { $lt: settleBefore } }, { sort: { createdAt: 1 }, limit: BATCH });
  for (const job of uploading) {
    // A file can be in storage without having been confirmed, when the browser closed right after the upload.
    const awaited = await store.items.find({ jobId: job._id, state: "awaiting_upload" });
    for (const item of awaited) {
      try {
        if ((await verifyArrival({ store, storage }, item)) === "accepted") report.uploadsRecovered += 1;
      } catch {
        report.deleteFailures += 1;
      }
    }
    touched.add(job.sessionId);
    if (await queueIfReady(store, job._id)) {
      report.jobsRequeued += 1;
    } else if (job.uploadDeadline.getTime() <= now.getTime()) {
      // The uploads never finished. Give back what the job holds.
      await store.jobs.updateOne({ _id: job._id, state: { $in: ["created", "uploading"] } }, { $set: { cancelRequested: true, updatedAt: now } });
      await finishCancelledJob(job._id);
      report.jobsAbandoned += 1;
    }
  }

  /* 2. Jobs that are ready but were never handed over. */
  const ready = await store.jobs.find({ mode: "async", state: "uploaded" }, { limit: BATCH });
  for (const job of ready) if (await queueIfReady(store, job._id)) report.jobsRequeued += 1;

  /* 3. Source uploads past their retention. */
  const sources = await store.items.find({ sourceStored: true, purgeSourceAt: { $lt: now } }, { sort: { purgeSourceAt: 1 }, limit: BATCH });
  for (const item of sources) {
    try {
      if (isOwnedPath(item.sessionId, item.path)) await storage.remove([item.path]);
    } catch {
      report.deleteFailures += 1;
      continue;
    }
    const marked = await store.items.updateOne({ _id: item._id, sourceStored: true }, { $set: { sourceStored: false, holdKind: "none", heldBytes: 0 } });
    if (marked.modified === 1) {
      await releaseSource(item.sessionId, item.heldBytes);
      report.sourcesDeleted += 1;
      touched.add(item.sessionId);
    }
  }

  /* 4. Generated files past their retention. The record stays, so History can say the file has expired. */
  const expired = await store.artifacts.find({ storage: "object", deletedAt: null, availableUntil: { $lt: now } }, { sort: { availableUntil: 1 }, limit: BATCH });
  const jobsToRefresh = new Set<string>();
  for (const artifact of expired) {
    try {
      if (isOwnedPath(artifact.sessionId, artifact.path)) await storage.remove([artifact.path]);
    } catch {
      report.deleteFailures += 1;
      continue;
    }
    const marked = await store.artifacts.updateOne({ _id: artifact._id, deletedAt: null }, { $set: { deletedAt: now } });
    if (marked.modified === 1) {
      await releaseArtifact(artifact.sessionId, artifact.byteSize);
      report.artifactsDeleted += 1;
      touched.add(artifact.sessionId);
      jobsToRefresh.add(artifact.jobId);
    }
  }
  for (const jobId of jobsToRefresh) await refreshJobSnapshot(store, jobId);

  /* 5. Counters. */
  for (const sessionId of touched) {
    await reconcileSession(sessionId);
    report.sessionsReconciled += 1;
  }
  await reconcileGlobal();

  /* 6. Jobs whose worker stopped: this run is a worker run too. */
  report.worker = await drainJobs({ budgetMs: options.workerBudgetMs ?? Math.min(capacity.workerBudgetMs, 120_000) });
  return report;
}

/**
 * Deletes everything a job holds: its source files, its generated files and
 * their records. Used when the owner deletes the job from History. Returns
 * false when a worker is processing the job right now.
 */
export async function purgeJob(sessionId: string, jobId: string): Promise<boolean> {
  const store = await pipelineStore();
  const job = await store.jobs.findOne({ _id: jobId, sessionId, mode: "async" });
  if (!job) return true;
  if (!["completed", "partial", "failed", "cancelled"].includes(job.state)) {
    await store.jobs.updateOne({ _id: jobId, state: job.state }, { $set: { cancelRequested: true, updatedAt: new Date() } });
    await finishCancelledJob(jobId);
    const after = await store.jobs.findOne({ _id: jobId });
    if (after && !["completed", "partial", "failed", "cancelled"].includes(after.state)) return false;
  }
  const storage = await getObjectStorage();
  const { items, artifacts } = await loadJobParts(store, jobId);
  const paths = [
    ...items.filter((item) => item.sourceStored && isOwnedPath(sessionId, item.path)).map((item) => item.path),
    ...artifacts.filter((artifact) => artifact.deletedAt === null && isOwnedPath(sessionId, artifact.path)).map((artifact) => artifact.path),
  ];
  // Objects first: if this fails, the records still name them and the deletion can be repeated.
  if (storage && paths.length > 0) await storage.remove(paths);
  await Promise.all([store.items.deleteMany({ jobId, sessionId }), store.artifacts.deleteMany({ jobId, sessionId, storage: "object" })]);
  await reconcileSession(sessionId);
  return true;
}
