/** Read models of the direct-upload pipeline: capacity, usage and generated files. */
import { advancedCapacity, capacity, limits } from "../config/env.js";
import { isOwnedPath } from "../storage/objectPaths.js";
import { getObjectStorage, type ObjectReader } from "../storage/objectStorage.js";
import { pipelineAvailability, TERMINAL_STATES } from "./jobs.js";
import { pipelineStore, type ArtifactRecord } from "./store.js";
import { GLOBAL_USAGE_ID, activeJobCount, readToday, readUsage, recordDay } from "./usage.js";
import type { ImageCapacity, UsageSummary } from "../../types/domain.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The Image Optimizer's limits in the mode that is in effect. The frontend
 * shows these numbers; it has none of its own.
 */
export async function imageCapacity(options: { maxWaitMs?: number } = {}): Promise<ImageCapacity> {
  const availability = await pipelineAvailability(options).catch(() => ({ available: false as const, reason: "database_unavailable", message: "The database cannot be reached right now." }));
  if (availability.available) {
    return {
      mode: "direct",
      directUnavailableReason: null,
      maxFileBytes: capacity.maxFileBytes,
      maxFiles: capacity.maxFiles,
      maxBatchBytes: capacity.maxBatchBytes,
      maxDecodedPixels: capacity.maxDecodedPixels,
      maxJobPixels: capacity.maxJobPixels,
      maxArtifactBytes: capacity.maxArtifactBytes,
      maxZipBytes: capacity.maxZipBytes,
      avifMaxPixels: capacity.avifMaxPixels,
      sessionQuotaBytes: capacity.sessionQuotaBytes,
      maxActiveJobs: capacity.maxActiveJobs,
      sourceTtlHours: Math.round(capacity.sourceTtlMs / 3_600_000),
      artifactTtlHours: Math.round(capacity.artifactTtlMs / 3_600_000),
      historyTtlDays: Math.round(capacity.historyTtlMs / 86_400_000),
    };
  }
  return {
    mode: "request",
    directUnavailableReason: availability.reason,
    maxFileBytes: limits.maxFileBytes,
    maxFiles: limits.maxFilesPerRequest,
    maxBatchBytes: limits.maxBatchBytes,
    maxDecodedPixels: limits.maxDecodedPixels,
    maxJobPixels: null,
    maxArtifactBytes: limits.maxArtifactBytes,
    maxZipBytes: limits.maxZipBytes,
    avifMaxPixels: null,
    sessionQuotaBytes: null,
    maxActiveJobs: null,
    sourceTtlHours: null,
    artifactTtlHours: limits.artifactTtlHours,
    historyTtlDays: Math.round(capacity.historyTtlMs / 86_400_000),
  };
}

export const advancedCapacityView = () => ({ ...advancedCapacity });

const emptyUsage = (available: boolean): UsageSummary => ({
  available,
  quotaBytes: capacity.sessionQuotaBytes,
  usedBytes: 0,
  remainingBytes: capacity.sessionQuotaBytes,
  reservedBytes: 0,
  sourceBytes: 0,
  artifactBytes: 0,
  nearQuota: false,
  activeJobs: 0,
  maxActiveJobs: capacity.maxActiveJobs,
  files: { sources: 0, artifacts: 0 },
  expiringSoon: [],
  lifetime: { uploads: 0, uploadBytes: 0, jobs: 0, failedJobs: 0, outputBytes: 0 },
  recentJobs: [],
  retention: {
    sourceHours: Math.round(capacity.sourceTtlMs / 3_600_000),
    artifactHours: Math.round(capacity.artifactTtlMs / 3_600_000),
    historyDays: Math.round(capacity.historyTtlMs / 86_400_000),
  },
});

/** What this session stores and may still store. */
export async function usageSummary(sessionId: string): Promise<UsageSummary> {
  const availability = await pipelineAvailability();
  if (!availability.available) return emptyUsage(false);
  const store = await pipelineStore();
  const now = new Date();
  const soon = new Date(now.getTime() + 3 * 86_400_000);
  const [usage, activeJobs, sources, artifacts, expiring, jobs] = await Promise.all([
    readUsage(sessionId),
    activeJobCount(sessionId),
    store.items.countDocuments({ sessionId, sourceStored: true }),
    store.artifacts.countDocuments({ sessionId, storage: "object", deletedAt: null }),
    store.artifacts.find({ sessionId, storage: "object", deletedAt: null, availableUntil: { $lt: soon } }, { sort: { availableUntil: 1 }, limit: 20 }),
    store.jobs.find({ sessionId, mode: "async" }, { sort: { createdAt: -1 }, limit: 8 }),
  ]);
  const clamp = (value: number): number => Math.max(0, Math.round(value));
  const reservedBytes = clamp(usage.reservedBytes);
  const sourceBytes = clamp(usage.sourceBytes);
  const artifactBytes = clamp(usage.artifactBytes);
  const usedBytes = reservedBytes + sourceBytes + artifactBytes;
  return {
    ...emptyUsage(true),
    usedBytes,
    remainingBytes: Math.max(0, capacity.sessionQuotaBytes - usedBytes),
    reservedBytes,
    sourceBytes,
    artifactBytes,
    nearQuota: usedBytes >= capacity.sessionQuotaBytes * capacity.warnAtFraction,
    activeJobs,
    files: { sources, artifacts },
    expiringSoon: expiring.map((artifact) => ({ artifactId: artifact._id, filename: artifact.filename, bytes: artifact.byteSize, expiresAt: artifact.availableUntil.toISOString(), jobId: artifact.jobId })),
    lifetime: { uploads: clamp(usage.uploads), uploadBytes: clamp(usage.uploadBytes), jobs: clamp(usage.jobs), failedJobs: clamp(usage.failedJobs), outputBytes: clamp(usage.outputBytes) },
    recentJobs: jobs.map((job) => ({ id: job._id, state: job.state, createdAt: job.createdAt.toISOString(), files: job.fileCount, inputBytes: job.inputBytes, savedBytes: TERMINAL_STATES.includes(job.state) ? job.savedBytes : 0 })),
  };
}

/** Application-wide usage against the configured budgets. For operators; contains no session data. */
export async function applicationUsage() {
  const store = await pipelineStore();
  const [global, today, activeJobs] = await Promise.all([
    readUsage(GLOBAL_USAGE_ID),
    readToday(),
    store.jobs.countDocuments({ mode: "async", state: { $in: ["created", "uploading", "uploaded", "queued", "processing"] } }),
  ]);
  const storedBytes = Math.max(0, global.reservedBytes + global.sourceBytes + global.artifactBytes);
  const uploadedToday = today?.uploadBytes ?? 0;
  const transforms = today?.transforms ?? 0;
  return {
    storage: {
      storedBytes,
      budgetBytes: capacity.globalStorageBudgetBytes,
      warning: storedBytes >= capacity.globalStorageBudgetBytes * capacity.warnAtFraction,
      sourceBytes: Math.max(0, global.sourceBytes),
      artifactBytes: Math.max(0, global.artifactBytes),
      reservedBytes: Math.max(0, global.reservedBytes),
    },
    today: {
      uploadBytes: uploadedToday,
      uploadBudgetBytes: capacity.globalDailyUploadBytes,
      warning: uploadedToday >= capacity.globalDailyUploadBytes * capacity.warnAtFraction,
      uploads: today?.uploads ?? 0,
      jobs: today?.jobs ?? 0,
      transforms,
      /** Wall-clock time spent converting, the main driver of function cost. */
      transformSeconds: Math.round((today?.transformMs ?? 0) / 100) / 10,
      averageTransformMs: transforms > 0 ? Math.round((today?.transformMs ?? 0) / transforms) : null,
      outputBytes: today?.outputBytes ?? 0,
      downloads: today?.downloads ?? 0,
      downloadBytes: today?.downloadBytes ?? 0,
      failures: today?.failures ?? 0,
      retries: today?.retries ?? 0,
    },
    activeJobs,
    lifetime: { uploads: global.uploads, uploadBytes: global.uploadBytes, jobs: global.jobs, failedJobs: global.failedJobs, outputBytes: global.outputBytes },
  };
}

/* ------------------------------------------------------------------ artifacts */

export type ObjectArtifact = {
  id: string;
  filename: string;
  itemFilename: string;
  contentType: string;
  bytes: number;
  crc32: number;
  createdAt: Date;
  /** Opens the file in storage. Null when the object is gone. */
  open: () => Promise<ObjectReader | null>;
};

function usable(artifact: ArtifactRecord, sessionId: string, now: number): boolean {
  return artifact.deletedAt === null && artifact.availableUntil.getTime() > now && isOwnedPath(sessionId, artifact.path);
}

/**
 * Generated files of this session that are kept in object storage. The lookup
 * is by ID **and** session, and the storage path must also lie in the
 * session's own area, so neither a guessed ID nor a tampered record can reach
 * another session's file.
 */
export async function objectArtifacts(sessionId: string, ids: string[]): Promise<ObjectArtifact[]> {
  const valid = [...new Set(ids.filter((id) => UUID.test(id)))];
  if (valid.length === 0) return [];
  const storage = await getObjectStorage();
  if (!storage) return [];
  const store = await pipelineStore();
  const now = Date.now();
  const records = await store.artifacts.find({ _id: { $in: valid }, sessionId, storage: "object" });
  const byId = new Map(records.filter((record) => usable(record, sessionId, now)).map((record) => [record._id, record]));
  return valid.flatMap((id) => {
    const record = byId.get(id);
    if (!record) return [];
    return [{
      id: record._id,
      filename: record.filename,
      itemFilename: record.itemFilename,
      contentType: record.contentType,
      bytes: record.byteSize,
      crc32: record.crc32,
      createdAt: record.createdAt,
      open: () => storage.read(record.path),
    }];
  });
}

/**
 * One generated file of this session by ID: the file when it can be served,
 * `"expired"` when its record exists but the file has been deleted, and null
 * when this session has no such file in object storage.
 */
export async function findObjectArtifact(sessionId: string, id: string): Promise<ObjectArtifact | "expired" | null> {
  if (!UUID.test(id)) return null;
  const storage = await getObjectStorage();
  if (!storage) return null;
  const store = await pipelineStore();
  const record = await store.artifacts.findOne({ _id: id, sessionId, storage: "object" });
  if (!record) return null;
  if (!usable(record, sessionId, Date.now())) return "expired";
  return {
    id: record._id,
    filename: record.filename,
    itemFilename: record.itemFilename,
    contentType: record.contentType,
    bytes: record.byteSize,
    crc32: record.crc32,
    createdAt: record.createdAt,
    open: () => storage.read(record.path),
  };
}

export type ArtifactStatus = {
  id: string;
  /** `available`: can be downloaded. `expired`: the record exists but the file has been deleted. */
  state: "available" | "expired";
  filename: string;
  contentType: string;
  bytes: number;
  expiresAt: string;
};

/** Whether a generated file of this session can still be downloaded. Null when the session has no such file. */
export async function objectArtifactStatus(sessionId: string, id: string): Promise<ArtifactStatus | null> {
  if (!UUID.test(id)) return null;
  const availability = await pipelineAvailability();
  if (!availability.available) return null;
  const store = await pipelineStore();
  const record = await store.artifacts.findOne({ _id: id, sessionId, storage: "object" });
  if (!record) return null;
  return {
    id: record._id,
    state: usable(record, sessionId, Date.now()) ? "available" : "expired",
    filename: record.filename,
    contentType: record.contentType,
    bytes: record.byteSize,
    expiresAt: record.availableUntil.toISOString(),
  };
}

/** Counts a finished download in today's application-wide counters. */
export const recordDownload = (bytes: number): Promise<void> => recordDay({ downloads: 1, downloadBytes: bytes });
