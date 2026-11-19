/**
 * Storage quotas, cost controls and shared rate limits.
 *
 * No limit depends on memory inside one process, and none is checked by
 * reading a value and then writing it:
 *
 *  - Byte budgets are counters that move with one conditional update: the
 *    counter changes only if the result stays within the limit.
 *  - Active jobs are slot documents. A session has a fixed number of slot IDs;
 *    taking a slot is inserting a document with one of them, and MongoDB's
 *    unique `_id` lets exactly one request win each.
 *
 * So requests that arrive together, on any number of serverless instances,
 * can never be admitted past a limit.
 *
 * A function that is killed between two writes can leave a counter too high
 * or a slot taken. Both err on the side of refusing. The scheduled sweep
 * recounts the counters from the records, and a slot whose job is finished or
 * was never created is taken back the next time the session asks for one.
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
  rev: 0,
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

  const session = await store.usage.updateOne(fits(sessionId, bytes, capacity.sessionQuotaBytes), { $inc: { reservedBytes: bytes, rev: 1 }, $set: { updatedAt: now } });
  if (session.matched === 0) return { ok: false, reason: "session_quota" };

  const global = await store.usage.updateOne(fits(GLOBAL_USAGE_ID, bytes, capacity.globalStorageBudgetBytes), { $inc: { reservedBytes: bytes, rev: 1 }, $set: { updatedAt: now } });
  if (global.matched === 0) {
    await store.usage.updateOne({ _id: sessionId }, { $inc: { reservedBytes: -bytes, rev: 1 } });
    return { ok: false, reason: "global_storage" };
  }

  const today = await store.days.updateOne({ _id: day, uploadBytes: { $lte: capacity.globalDailyUploadBytes - bytes } }, { $inc: { uploadBytes: bytes } });
  if (today.matched === 0) {
    await Promise.all([
      store.usage.updateOne({ _id: sessionId }, { $inc: { reservedBytes: -bytes, rev: 1 } }),
      store.usage.updateOne({ _id: GLOBAL_USAGE_ID }, { $inc: { reservedBytes: -bytes, rev: 1 } }),
    ]);
    return { ok: false, reason: "global_daily_upload" };
  }
  return { ok: true };
}

/** Moves bytes between counters of a session and of the application in one update each. */
async function adjust(sessionId: string, delta: Partial<Record<"reservedBytes" | "sourceBytes" | "artifactBytes" | "uploads" | "uploadBytes" | "jobs" | "failedJobs" | "outputBytes", number>>): Promise<void> {
  const store = await pipelineStore();
  const update = { $inc: { ...delta, rev: 1 }, $set: { updatedAt: new Date() } };
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
  const update = { $inc: { artifactBytes: delta, rev: 1 }, $set: { updatedAt: new Date() } };
  if (delta <= 0) {
    await Promise.all([store.usage.updateOne({ _id: sessionId }, update), store.usage.updateOne({ _id: GLOBAL_USAGE_ID }, update)]);
    return true;
  }
  const session = await store.usage.updateOne(fits(sessionId, delta, capacity.sessionQuotaBytes), update);
  if (session.matched === 0) return false;
  const global = await store.usage.updateOne(fits(GLOBAL_USAGE_ID, delta, capacity.globalStorageBudgetBytes), update);
  if (global.matched === 0) {
    await store.usage.updateOne({ _id: sessionId }, { $inc: { artifactBytes: -delta, rev: 1 } });
    return false;
  }
  return true;
}

/** Adds a generated file to the lifetime output counters. */
export const recordOutput = (sessionId: string, bytes: number): Promise<void> => adjust(sessionId, { outputBytes: bytes });

/** Digest of a session ID for use inside a document ID. The session ID is a credential and is not put there. */
const ownerDigest = (sessionId: string): string => createHash("sha256").update(`optiweb-slot:${sessionId}`).digest("hex").slice(0, 24);

const TERMINAL_JOB_STATES = ["completed", "partial", "failed", "cancelled"];
/** A slot whose job record never appeared is taken back after this long. Longer than any admission takes. */
const ORPHAN_SLOT_MS = 120_000;

/**
 * Takes one of the session's active-job slots for `jobId`. False when all are
 * in use. Each slot is a document with a fixed ID, so inserting it is the
 * claim: of any number of simultaneous requests, one gets each slot.
 */
export async function acquireJobSlot(sessionId: string, jobId: string): Promise<boolean> {
  const store = await pipelineStore();
  const owner = ownerDigest(sessionId);
  const claim = async (): Promise<boolean> => {
    for (let index = 0; index < capacity.maxActiveJobs; index += 1) {
      try {
        const now = new Date();
        // The expiry only bounds how long a slot can outlive a crashed request; live jobs finish long before.
        await store.slots.insertOne({ _id: `${owner}:${index}`, sessionId, jobId, createdAt: now, expireAt: new Date(now.getTime() + 7 * 86_400_000) });
        return true;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    }
    return false;
  };
  if (await claim()) return true;

  // All slots are taken. Give back those that no running job holds: the job
  // has finished, or its record never appeared because the request died.
  const held = await store.slots.find({ sessionId });
  let freed = 0;
  for (const slot of held) {
    const job = await store.jobs.findOne({ _id: slot.jobId });
    const stale = job ? TERMINAL_JOB_STATES.includes(job.state) : Date.now() - slot.createdAt.getTime() > ORPHAN_SLOT_MS;
    if (stale) freed += await store.slots.deleteOne({ _id: slot._id, jobId: slot.jobId });
  }
  return freed > 0 ? claim() : false;
}

/** Gives back the slot that `jobId` holds. Does nothing when it holds none. */
export async function releaseJobSlot(sessionId: string, jobId: string): Promise<void> {
  const store = await pipelineStore();
  await store.slots.deleteMany({ sessionId, jobId });
}

/** Unfinished jobs of this session, counted from the slots they hold. */
export async function activeJobCount(sessionId: string): Promise<number> {
  const store = await pipelineStore();
  return store.slots.countDocuments({ sessionId });
}

/** Adds to a session's lifetime job counters. */
export const recordJob = (sessionId: string, failed: boolean): Promise<void> => adjust(sessionId, failed ? { failedJobs: 1 } : { jobs: 1 });

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
 * Recomputes a session's byte counters from its records. The scheduled sweep
 * calls it, which repairs drift left by an interrupted request.
 *
 * The result is written only if the counters have not changed since they were
 * read. If a request moved them meanwhile, this recount is dropped rather
 * than overwrite that request's change; the next sweep tries again.
 */
export async function reconcileSession(sessionId: string): Promise<boolean> {
  const store = await pipelineStore();
  await ensureUsage(store, sessionId);
  const before = await store.usage.findOne({ _id: sessionId });
  if (!before) return false;
  const [held, artifacts] = await Promise.all([
    store.items.aggregate<{ _id: string; bytes: number }>([
      { $match: { sessionId, holdKind: { $in: ["reservation", "source"] } } },
      { $group: { _id: "$holdKind", bytes: { $sum: "$heldBytes" } } },
    ]),
    store.artifacts.aggregate<{ _id: null; bytes: number }>([
      { $match: { sessionId, storage: "object", deletedAt: null } },
      { $group: { _id: null, bytes: { $sum: "$byteSize" } } },
    ]),
  ]);
  const of = (kind: string): number => held.find((row) => row._id === kind)?.bytes ?? 0;
  const written = await store.usage.updateOne(
    { _id: sessionId, rev: before.rev },
    { $set: { reservedBytes: of("reservation"), sourceBytes: of("source"), artifactBytes: artifacts[0]?.bytes ?? 0, updatedAt: new Date() }, $inc: { rev: 1 } },
  );
  return written.matched === 1;
}

/** Recomputes the application-wide storage counters from the session counters. */
export async function reconcileGlobal(): Promise<void> {
  const store = await pipelineStore();
  await ensureUsage(store, GLOBAL_USAGE_ID);
  const before = await store.usage.findOne({ _id: GLOBAL_USAGE_ID });
  const [row] = await store.usage.aggregate<{ reserved: number; source: number; artifact: number }>([
    { $match: { _id: { $ne: GLOBAL_USAGE_ID } } },
    { $group: { _id: null, reserved: { $sum: "$reservedBytes" }, source: { $sum: "$sourceBytes" }, artifact: { $sum: "$artifactBytes" } } },
  ]);
  // Same rule as for a session: a recount never overwrites a change made while it was computed.
  await store.usage.updateOne(
    { _id: GLOBAL_USAGE_ID, rev: before?.rev ?? 0 },
    { $set: { reservedBytes: row?.reserved ?? 0, sourceBytes: row?.source ?? 0, artifactBytes: row?.artifact ?? 0, updatedAt: new Date() }, $inc: { rev: 1 } },
  );
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
