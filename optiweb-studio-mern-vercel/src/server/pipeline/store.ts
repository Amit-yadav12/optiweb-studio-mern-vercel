/**
 * Database access for the direct-upload pipeline.
 *
 * The pipeline uses a small, explicit subset of MongoDB: single-document
 * operations with plain operators. Each of them is atomic in MongoDB, which is
 * what job claims, quota reservations and idempotent writes rely on. No
 * multi-document transaction is needed, so a standalone server and an Atlas
 * replica set behave the same.
 *
 * `DocCollection` is that subset. `mongoCollection` implements it on the
 * MongoDB driver. Tests can supply another implementation with
 * `setPipelineStoreForTests`; results obtained that way show that the
 * application logic is right, not that MongoDB accepts the queries.
 */
import type { Collection, Document } from "mongodb";
import { JOBS_COLLECTION, connectMongo, unwrap } from "../db/mongo.js";
import { StorageUnavailableError, classifyStorageError, logStorageFailure, type StorageStage } from "../db/storageDiagnostics.js";
import type { ImageOptimizeSettings, JobItemState, JobState } from "../../types/domain.js";

export type Filter = Record<string, unknown>;
export type Update = Record<string, unknown>;
export type Sort = Record<string, 1 | -1>;

export interface DocCollection<T extends { _id: string }> {
  findOne(filter: Filter, options?: { sort?: Sort }): Promise<T | null>;
  find(filter: Filter, options?: { sort?: Sort; limit?: number; skip?: number }): Promise<T[]>;
  /** Throws an error for which `isDuplicateKey` is true when `_id` already exists. */
  insertOne(doc: T): Promise<void>;
  /** With `upsert`, the filter must be `{ _id }` only. */
  updateOne(filter: Filter, update: Update, options?: { upsert?: boolean }): Promise<{ matched: number; modified: number; upserted: boolean }>;
  updateMany(filter: Filter, update: Update): Promise<{ matched: number; modified: number }>;
  /** With `upsert`, the filter must be `{ _id }` only. */
  findOneAndUpdate(filter: Filter, update: Update, options?: { sort?: Sort; upsert?: boolean; returnDocument?: "before" | "after" }): Promise<T | null>;
  deleteOne(filter: Filter): Promise<number>;
  deleteMany(filter: Filter): Promise<number>;
  countDocuments(filter: Filter): Promise<number>;
  aggregate<R>(pipeline: Record<string, unknown>[]): Promise<R[]>;
}

/** MongoDB reports a violated unique key, including `_id`, with code 11000. */
export function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;
}

/**
 * Runs one database call. A driver error is reduced to a failure category,
 * logged once without its message, and rethrown as the API's 503 storage
 * error. A duplicate key is passed through: callers use it as a signal.
 */
async function guarded<R>(name: string, operation: string, stage: StorageStage, call: () => Promise<R>): Promise<R> {
  const startedAt = Date.now();
  try {
    return await call();
  } catch (error) {
    if (isDuplicateKey(error) || error instanceof StorageUnavailableError) throw error;
    const category = classifyStorageError(error, stage);
    logStorageFailure({ category, operation: `pipeline.${name}.${operation}`, stage, error: unwrap(error), durationMs: Date.now() - startedAt });
    throw new StorageUnavailableError(category, { cause: error });
  }
}

function mongoCollection<T extends { _id: string }>(name: string, collection: Collection<Document>): DocCollection<T> {
  const read = <R>(operation: string, call: () => Promise<R>): Promise<R> => guarded(name, operation, "read", call);
  const write = <R>(operation: string, call: () => Promise<R>): Promise<R> => guarded(name, operation, "write", call);
  return {
    findOne: (filter, options) => read("findOne", async () => (await collection.findOne(filter, { sort: options?.sort })) as T | null),
    find: (filter, options) =>
      read("find", async () => {
        let cursor = collection.find(filter);
        if (options?.sort) cursor = cursor.sort(options.sort);
        if (options?.skip) cursor = cursor.skip(options.skip);
        if (options?.limit) cursor = cursor.limit(options.limit);
        return (await cursor.toArray()) as unknown as T[];
      }),
    insertOne: (doc) =>
      write("insertOne", async () => {
        await collection.insertOne(doc as unknown as Document);
      }),
    updateOne: (filter, update, options) =>
      write("updateOne", async () => {
        const result = await collection.updateOne(filter, update, { upsert: options?.upsert ?? false });
        return { matched: result.matchedCount, modified: result.modifiedCount, upserted: result.upsertedCount > 0 };
      }),
    updateMany: (filter, update) =>
      write("updateMany", async () => {
        const result = await collection.updateMany(filter, update);
        return { matched: result.matchedCount, modified: result.modifiedCount };
      }),
    findOneAndUpdate: (filter, update, options) =>
      write("findOneAndUpdate", async () => {
        const result = await collection.findOneAndUpdate(filter, update, {
          sort: options?.sort,
          upsert: options?.upsert ?? false,
          returnDocument: options?.returnDocument ?? "after",
          includeResultMetadata: false,
        });
        return result as T | null;
      }),
    deleteOne: (filter) => write("deleteOne", async () => (await collection.deleteOne(filter)).deletedCount),
    deleteMany: (filter) => write("deleteMany", async () => (await collection.deleteMany(filter)).deletedCount),
    countDocuments: (filter) => read("countDocuments", () => collection.countDocuments(filter)),
    aggregate: <R>(pipeline: Record<string, unknown>[]) => read("aggregate", async () => (await collection.aggregate(pipeline).toArray()) as R[]),
  };
}

/* ------------------------------------------------------------------ records */

/** Legacy-shaped copy of one item, embedded in the job record for the History pages. */
export type JobItemSnapshot = {
  id: string;
  filename: string;
  outputFilename: string | null;
  status: string;
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  savingsPercent: number | null;
  inputWidth: number | null;
  inputHeight: number | null;
  outputWidth: number | null;
  outputHeight: number | null;
  outputFormat: string | null;
  message: string | null;
  artifactId: string | null;
};

/**
 * A background job in `optiweb_jobs`. The first block of fields is shared with
 * the records that the synchronous tools write, so History lists both.
 */
export type JobRecord = {
  _id: string;
  sessionId: string;
  kind: "image.optimize";
  /** Same value as `state`. History filters on this field. */
  status: string;
  label: string;
  fileCount: number;
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  note: string | null;
  items: JobItemSnapshot[];
  createdAt: Date;

  /** Marks a record of the direct-upload pipeline. */
  mode: "async";
  state: JobState;
  settings: ImageOptimizeSettings;
  updatedAt: Date;
  uploadedAt: Date | null;
  queuedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Worker that currently owns the job, and until when. */
  leaseOwner: string | null;
  leaseUntil: Date | null;
  /** Times a worker has claimed the job. */
  claims: number;
  cancelRequested: boolean;
  /** Decoded pixels of the items processed so far, for the per-job pixel budget. */
  pixelsUsed: number;
  /**
   * True once the job holds a job slot and its storage reservation. Uploads
   * are only authorized for an admitted job. A record that stays unadmitted
   * belongs to a request that died half-way; the sweep removes it.
   */
  admitted: boolean;
  /** Uploads must finish before this time, or the job is cancelled. */
  uploadDeadline: Date;
  /** When MongoDB removes the record (History retention). */
  expireAt: Date;
};

export type ItemResult = {
  outputFilename: string;
  outputBytes: number;
  savedBytes: number;
  savingsPercent: number;
  inputWidth: number | null;
  inputHeight: number | null;
  outputWidth: number | null;
  outputHeight: number | null;
  outputFormat: string;
  durationMs: number;
  retainedOriginal: boolean;
  pixels: number;
};

/** One source file of a job, in `optiweb_uploads`: the upload, its processing state and its result. */
export type ItemRecord = {
  _id: string;
  jobId: string;
  sessionId: string;
  index: number;
  /** Sanitised name of the source file. */
  filename: string;
  /** Content type the browser declared and the upload token allows. */
  contentType: string;
  /** Size the browser declared. The stored object must have exactly this size. */
  declaredBytes: number;
  /** Server-generated storage path of the source file. */
  path: string;
  state: JobItemState;
  /** Whether the source object is (still) in storage. */
  sourceStored: boolean;
  /** Bytes of quota this item holds for its source: a reservation before upload, the stored size after. */
  heldBytes: number;
  holdKind: "reservation" | "source" | "none";
  attempts: number;
  errorCode: string | null;
  message: string | null;
  retryable: boolean;
  result: ItemResult | null;
  artifactId: string | null;
  createdAt: Date;
  uploadedAt: Date | null;
  finishedAt: Date | null;
  /** Source object is deleted after this time. Set when the job finishes. */
  purgeSourceAt: Date | null;
  expireAt: Date;
};

/** A generated file in `optiweb_artifacts`. The bytes are in object storage, never in this record. */
export type ArtifactRecord = {
  _id: string;
  jobId: string;
  sessionId: string;
  itemId: string;
  filename: string;
  itemFilename: string;
  contentType: string;
  byteSize: number;
  /** CRC-32 of the file, recorded when it was generated. ZIP downloads use it, and check the stored bytes against it. */
  crc32: number;
  kind: "image";
  storage: "object";
  path: string;
  createdAt: Date;
  /** The file is deleted from storage after this time. */
  availableUntil: Date;
  /** Set once the file has been deleted from storage. The record stays for History. */
  deletedAt: Date | null;
  expireAt: Date;
};

/** Storage and activity counters of one session, or of the whole application (`_id: "global"`). */
export type UsageRecord = {
  _id: string;
  /** Bytes promised to uploads that have not finished. */
  reservedBytes: number;
  sourceBytes: number;
  artifactBytes: number;
  /** Incremented by every change to the byte counters. A recount is only written if it has not moved meanwhile. */
  rev: number;
  uploads: number;
  uploadBytes: number;
  jobs: number;
  failedJobs: number;
  outputBytes: number;
  updatedAt: Date;
};

/** Application-wide counters of one UTC day (`_id: "day:YYYY-MM-DD"`). */
export type DayRecord = {
  _id: string;
  uploadBytes: number;
  uploads: number;
  jobs: number;
  transforms: number;
  transformMs: number;
  outputBytes: number;
  downloads: number;
  downloadBytes: number;
  failures: number;
  retries: number;
  expireAt: Date;
};

export type RateRecord = { _id: string; count: number; expireAt: Date };

/**
 * One of a session's active-job slots, held by one job. The `_id` names the
 * session and the slot number, so MongoDB's unique `_id` guarantees that a
 * slot has one holder, however many requests arrive together.
 */
export type SlotRecord = { _id: string; sessionId: string; jobId: string; createdAt: Date; expireAt: Date };

export type PipelineStore = {
  jobs: DocCollection<JobRecord>;
  items: DocCollection<ItemRecord>;
  artifacts: DocCollection<ArtifactRecord>;
  usage: DocCollection<UsageRecord>;
  days: DocCollection<DayRecord>;
  rate: DocCollection<RateRecord>;
  slots: DocCollection<SlotRecord>;
};

export const COLLECTIONS = {
  jobs: JOBS_COLLECTION,
  items: "optiweb_uploads",
  artifacts: "optiweb_artifacts",
  usage: "optiweb_usage",
  days: "optiweb_usage_days",
  rate: "optiweb_rate_limits",
  slots: "optiweb_job_slots",
} as const;

let override: PipelineStore | null = null;
let indexesReady: Promise<void> | null = null;
/** The collections of the current connection. Rebuilt when the connection is replaced. */
let connected: { db: unknown; store: PipelineStore } | null = null;

/** Test hook: use these collections instead of MongoDB. `null` restores MongoDB. */
export function setPipelineStoreForTests(store: PipelineStore | null): void {
  override = store;
}

/** Whether the pipeline's database is a test stand-in. The readiness check uses it. */
export function hasPipelineStoreOverride(): boolean {
  return override !== null;
}

/**
 * The pipeline's collections. Connects if needed and creates the indexes the
 * pipeline depends on once per process. Throws `StorageUnavailableError` when
 * the database cannot be reached.
 */
export async function pipelineStore(): Promise<PipelineStore> {
  if (override) return override;
  const client = await connectMongo();
  const db = client.connection.db;
  if (!db) throw new Error("MongoDB connection has no database handle.");
  if (connected?.db === db) {
    await indexesReady;
    return connected.store;
  }
  const raw = {
    jobs: db.collection(COLLECTIONS.jobs),
    items: db.collection(COLLECTIONS.items),
    artifacts: db.collection(COLLECTIONS.artifacts),
    usage: db.collection(COLLECTIONS.usage),
    days: db.collection(COLLECTIONS.days),
    rate: db.collection(COLLECTIONS.rate),
    slots: db.collection(COLLECTIONS.slots),
  };
  indexesReady ??= (async () => {
    // TTL indexes remove records only; object storage is cleaned by the
    // cleanup routine before a record can expire.
    await Promise.all([
      raw.jobs.createIndex({ mode: 1, state: 1, leaseUntil: 1 }),
      raw.jobs.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      raw.items.createIndex({ jobId: 1, index: 1 }),
      raw.items.createIndex({ sessionId: 1, state: 1 }),
      raw.items.createIndex({ sourceStored: 1, purgeSourceAt: 1 }),
      raw.items.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      raw.artifacts.createIndex({ storage: 1, deletedAt: 1, availableUntil: 1 }),
      raw.artifacts.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      raw.days.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      raw.rate.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      raw.slots.createIndex({ sessionId: 1 }),
      raw.slots.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
  })().catch((error: unknown) => {
    // Index creation is retried on the next call. The pipeline works without
    // the indexes, only slower, so a failure here does not fail the request.
    indexesReady = null;
    console.error(`[pipeline] index creation failed (${error instanceof Error ? error.name : "unknown error"})`);
  });
  await indexesReady;
  const store: PipelineStore = {
    jobs: mongoCollection<JobRecord>("jobs", raw.jobs),
    items: mongoCollection<ItemRecord>("items", raw.items),
    artifacts: mongoCollection<ArtifactRecord>("artifacts", raw.artifacts),
    usage: mongoCollection<UsageRecord>("usage", raw.usage),
    days: mongoCollection<DayRecord>("days", raw.days),
    rate: mongoCollection<RateRecord>("rate", raw.rate),
    slots: mongoCollection<SlotRecord>("slots", raw.slots),
  };
  connected = { db, store };
  return store;
}
