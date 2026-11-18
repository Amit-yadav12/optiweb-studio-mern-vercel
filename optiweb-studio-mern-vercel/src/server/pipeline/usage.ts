/**
 * Storage quotas, cost controls and shared rate limits.
 *
 * Every limit is enforced with one conditional update: the counter moves only
 * if the result stays within the limit. Two requests that arrive together can
 * therefore never both be admitted past a limit, on any number of serverless
 * instances. No limit depends on memory inside one process.
 *
 * Counters can drift if a function is killed between two updates. The cleanup
 * routine recomputes them from the records (`reconcileSession`).
 */
import { createHash } from "node:crypto";
import { capacity, rateLimits, type RateLimitBucket } from "../config/env.js";
import { ApiError } from "../http/errors.js";
import { isDuplicateKey, pipelineStore, type DayRecord, type PipelineStore, type UsageRecord } from "./store.js";

export const GLOBAL_USAGE_ID = "global";

const emptyUsage = (id: string): UsageRecord => ({
  _id: id,
  reservedBytes: 0,
  sourceBytes: 0,
  artifactBytes: 0,
  activeJobs: 0,
  uploads: 0,
  uploadBytes: 0,
  jobs: 0,
  failedJobs: 0,
  outputBytes: 0,
  updatedAt: new Date(),
});

const dayId = (at = new Date()): string => `day:${at.toISOString().slice(0, 10)}`;

/** Creates the counter record if it does not exist yet. Safe to call concurrently. */
async function ensureUsage(store: PipelineStore, id: string): Promise<void> {
  try {
    await store.usage.insertOne(emptyUsage(id));
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
}

async function ensureDay(store: PipelineStore, id: string): Promise<void> {
  const record: DayRecord = {
    _id: id,
    uploadBytes: 0,
    uploads: 0,
    jobs: 0,
    transforms: 0,
    transformMs: 0,
    outputBytes: 0,
    downloads: 0,
    downloadBytes: 0,
    failures: 0,
    retries: 0,
    // Daily counters are kept for 90 days.
    expireAt: new Date(Date.now() + 90 * 86_400_000),
  };
  try {
    await store.days.insertOne(record);
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
}

/** Filter that matches a usage record only while `bytes` more still fit under `limit`. */
const fits = (id: string, bytes: number, limit: number) => ({
  _id: id,
  $expr: { $lte: [{ $add: ["$reservedBytes", "$sourceBytes", "$artifactBytes"] }, limit - bytes] },
});

export type ReservationRefusal = "session_quota" | "global_storage" | "global_daily_upload";

/**
 * Reserves room for uploads that are about to start: in the session's quota,
 * in the application's storage budget and in today's upload budget. All three
 * are taken, or none.
 */
export async function reserveUploadBytes(sessionId: string, bytes: number): Promise<{ ok: true } | { ok: false; reason: ReservationRefusal }> {
  const store = await pipelineStore();
  const day = dayId();
  await Promise.all([ensureUsage(store, sessionId), ensureUsage(store, GLOBAL_USAGE_ID), ensureDay(store, day)]);
  const now = new Date();

  const session = await store.usage.updateOne(fits(sessionId, bytes, capacity.sessionQuotaBytes), { $inc: { reservedBytes: bytes }, $set: { updatedAt: now } });
  if (session.matched === 0) return { ok: false, reason: "session_quota" };

  const global = await store.usage.updateOne(fits(GLOBAL_USAGE_ID, bytes, capacity.globalStorageBudgetBytes), { $inc: { reservedBytes: bytes }, $set: { updatedAt: now } });
  if (global.matched === 0) {
    await store.usage.updateOne({ _id: sessionId }, { $inc: { reservedBytes: -bytes } });
    return { ok: false, reason: "global_storage" };
  }

  const today = await store.days.updateOne({ _id: day, uploadBytes: { $lte: capacity.globalDailyUploadBytes - bytes } }, { $inc: { uploadBytes: bytes } });
  if (today.matched === 0) {
    await Promise.all([
      store.usage.updateOne({ _id: sessionId }, { $inc: { reservedBytes: -bytes } }),
      store.usage.updateOne({ _id: GLOBAL_USAGE_ID }, { $inc: { reservedBytes: -bytes } }),
    ]);
    return { ok: false, reason: "global_daily_upload" };
  }
  return { ok: true };
}

/** Moves bytes between counters of a session and of the application in one update each. */
async function adjust(sessionId: string, delta: Partial<Record<"reservedBytes" | "sourceBytes" | "artifactBytes" | "uploads" | "uploadBytes" | "jobs" | "failedJobs" | "outputBytes", number>>): Promise<void> {
  const store = await pipelineStore();
  const update = { $inc: delta, $set: { updatedAt: new Date() } };
  await Promise.all([store.usage.updateOne({ _id: sessionId }, update), store.usage.updateOne({ _id: GLOBAL_USAGE_ID }, update)]);
}

/** A reserved upload arrived: the reservation becomes stored source bytes. */
export const settleUpload = (sessionId: string, reserved: number, stored: number): Promise<void> =>
  adjust(sessionId, { reservedBytes: -reserved, sourceBytes: stored, uploads: 1, uploadBytes: stored });

/** A reserved upload will not arrive. */
export const releaseReservation = (sessionId: string, bytes: number): Promise<void> => adjust(sessionId, { reservedBytes: -bytes });

/** A stored source file was deleted. */
export const releaseSource = (sessionId: string, bytes: number): Promise<void> => adjust(sessionId, { sourceBytes: -bytes });

/** A generated file was deleted. */
export const releaseArtifact = (sessionId: string, bytes: number): Promise<void> => adjust(sessionId, { artifactBytes: -bytes });

/**
 * Takes room for a generated file. `previous` is the size of the file it
 * replaces, when a retry writes the same artifact again. Returns false when
 * the file does not fit in the session's quota or the application's budget.
 */
export async function reserveArtifactBytes(sessionId: string, bytes: number, previous = 0): Promise<boolean> {
  const store = await pipelineStore();
  const delta = bytes - previous;
  const update = { $inc: { artifactBytes: delta }, $set: { updatedAt: new Date() } };
  if (delta <= 0) {
    await Promise.all([store.usage.updateOne({ _id: sessionId }, update), store.usage.updateOne({ _id: GLOBAL_USAGE_ID }, update)]);
    return true;
  }
  const session = await store.usage.updateOne(fits(sessionId, delta, capacity.sessionQuotaBytes), update);
  if (session.matched === 0) return false;
  const global = await store.usage.updateOne(fits(GLOBAL_USAGE_ID, delta, capacity.globalStorageBudgetBytes), update);
  if (global.matched === 0) {
    await store.usage.updateOne({ _id: sessionId }, { $inc: { artifactBytes: -delta } });
    return false;
  }
  return true;
}

/** Adds a generated file to the lifetime output counters. */
export const recordOutput = (sessionId: string, bytes: number): Promise<void> => adjust(sessionId, { outputBytes: bytes });

/** Takes one of the session's active-job slots. False when all are in use. */
export async function acquireJobSlot(sessionId: string): Promise<boolean> {
  const store = await pipelineStore();
  await ensureUsage(store, sessionId);
  const taken = await store.usage.updateOne({ _id: sessionId, activeJobs: { $lt: capacity.maxActiveJobs } }, { $inc: { activeJobs: 1, jobs: 1 }, $set: { updatedAt: new Date() } });
  return taken.matched === 1;
}

export async function releaseJobSlot(sessionId: string, failed: boolean): Promise<void> {
  const store = await pipelineStore();
  await store.usage.updateOne({ _id: sessionId }, { $inc: { activeJobs: -1, failedJobs: failed ? 1 : 0 }, $set: { updatedAt: new Date() } });
}

/** Adds to today's application-wide counters. Never fails the caller. */
export async function recordDay(delta: Partial<Record<"uploads" | "jobs" | "transforms" | "transformMs" | "outputBytes" | "downloads" | "downloadBytes" | "failures" | "retries", number>>): Promise<void> {
  try {
    const store = await pipelineStore();
    const id = dayId();
    await ensureDay(store, id);
    await store.days.updateOne({ _id: id }, { $inc: delta });
  } catch {
    /* counters are informational */
  }
}

/**
 * Recomputes a session's counters from its records. The cleanup routine calls
 * it for sessions it touched, which repairs drift left by an interrupted update.
 */
export async function reconcileSession(sessionId: string): Promise<void> {
  const store = await pipelineStore();
  const [held, artifacts, active] = await Promise.all([
    store.items.aggregate<{ _id: string; bytes: number }>([
      { $match: { sessionId, holdKind: { $in: ["reservation", "source"] } } },
      { $group: { _id: "$holdKind", bytes: { $sum: "$heldBytes" } } },
    ]),
    store.artifacts.aggregate<{ _id: null; bytes: number }>([
      { $match: { sessionId, storage: "object", deletedAt: null } },
      { $group: { _id: null, bytes: { $sum: "$byteSize" } } },
    ]),
    store.jobs.countDocuments({ sessionId, mode: "async", slotReleased: false }),
  ]);
  const of = (kind: string): number => held.find((row) => row._id === kind)?.bytes ?? 0;
  await ensureUsage(store, sessionId);
  await store.usage.updateOne(
    { _id: sessionId },
    { $set: { reservedBytes: of("reservation"), sourceBytes: of("source"), artifactBytes: artifacts[0]?.bytes ?? 0, activeJobs: active, updatedAt: new Date() } },
  );
}

/** Recomputes the application-wide storage counters from the session counters. */
export async function reconcileGlobal(): Promise<void> {
  const store = await pipelineStore();
  const [row] = await store.usage.aggregate<{ reserved: number; source: number; artifact: number }>([
    { $match: { _id: { $ne: GLOBAL_USAGE_ID } } },
    { $group: { _id: null, reserved: { $sum: "$reservedBytes" }, source: { $sum: "$sourceBytes" }, artifact: { $sum: "$artifactBytes" } } },
  ]);
  await ensureUsage(store, GLOBAL_USAGE_ID);
  await store.usage.updateOne({ _id: GLOBAL_USAGE_ID }, { $set: { reservedBytes: row?.reserved ?? 0, sourceBytes: row?.source ?? 0, artifactBytes: row?.artifact ?? 0, updatedAt: new Date() } });
}

export async function readUsage(id: string): Promise<UsageRecord> {
  const store = await pipelineStore();
  return (await store.usage.findOne({ _id: id })) ?? emptyUsage(id);
}

export async function readToday(): Promise<DayRecord | null> {
  const store = await pipelineStore();
  return store.days.findOne({ _id: dayId() });
}

/**
 * Rate limit counted in the database, so it holds across serverless instances.
 * One window per bucket and session; the window record expires on its own.
 */
export async function consumeSharedRateLimit(bucket: RateLimitBucket, sessionId: string): Promise<void> {
  const config = rateLimits[bucket];
  const store = await pipelineStore();
  const window = Math.floor(Date.now() / config.windowMs);
  // The session ID is a credential, so only a digest of it is stored.
  const owner = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  const id = `${bucket}:${owner}:${window}`;
  const expireAt = new Date((window + 2) * config.windowMs);
  let count = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const record = await store.rate.findOneAndUpdate({ _id: id }, { $inc: { count: 1 }, $setOnInsert: { expireAt } }, { upsert: true, returnDocument: "after" });
      count = record?.count ?? 1;
      break;
    } catch (error) {
      // Two instances can both try to create the window record; the loser retries as an update.
      if (!isDuplicateKey(error) || attempt === 1) throw error;
    }
  }
  if (count > config.capacity) {
    const retryAfterSeconds = Math.max(1, Math.ceil(((window + 1) * config.windowMs - Date.now()) / 1000));
    throw new ApiError(429, "rate_limited", "Too many requests. Please wait a moment and try again.", { details: { retryAfterSeconds } });
  }
}
