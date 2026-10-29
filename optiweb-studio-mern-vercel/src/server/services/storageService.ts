/**
 * MongoDB persistence for session-scoped jobs, metadata, preferences and output artifacts.
 * Artifacts are kept as separate documents and bounded by the deployment's upload/output limits.
 */
import mongoose, { Schema, type FilterQuery, type Model } from "mongoose";
import { randomUUID } from "node:crypto";
import { connectMongo } from "@/server/db/mongo";
import { limits } from "@/server/config/env";
import type {
  HistoryEntry,
  HistoryPage,
  ImageResult,
  JobKind,
  JobStatus,
  Preferences,
} from "@/types/domain";

export type PersistItem = {
  filename: string;
  outputFilename?: string;
  status: "completed" | "failed";
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  savingsPercent: number | null;
  inputWidth?: number | null;
  inputHeight?: number | null;
  outputWidth?: number | null;
  outputHeight?: number | null;
  outputFormat?: string | null;
  message?: string;
  artifact?: { filename: string; contentType: string; data: Buffer; kind: string } | null;
};

type JobItemDoc = {
  id: string;
  filename: string;
  outputFilename: string | null;
  status: "completed" | "failed";
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

type JobDoc = {
  _id: string;
  sessionId: string;
  kind: JobKind;
  status: JobStatus;
  label: string;
  fileCount: number;
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  note: string | null;
  items: JobItemDoc[];
  createdAt: Date;
};

type ArtifactDoc = {
  _id: string;
  jobId: string;
  sessionId: string;
  filename: string;
  itemFilename: string;
  contentType: string;
  byteSize: number;
  kind: string;
  data: Buffer;
  createdAt: Date;
  expiresAt: Date;
};

type PreferenceDoc = {
  sessionId: string;
  defaultImageFormat: Preferences["defaultImageFormat"];
  defaultQuality: number;
  defaultMaxWidth: number | null;
  fontDisplayPolicy: Preferences["fontDisplayPolicy"];
  analyzerThresholdKb: number;
  reduceMotion: boolean;
  updatedAt: Date;
};

const JobItemSchema = new Schema<JobItemDoc>({
  id: { type: String, required: true },
  filename: { type: String, required: true },
  outputFilename: { type: String, default: null },
  status: { type: String, enum: ["completed", "failed"], required: true },
  inputBytes: { type: Number, required: true, min: 0 },
  outputBytes: { type: Number, required: true, min: 0 },
  savedBytes: { type: Number, required: true },
  savingsPercent: { type: Number, default: null },
  inputWidth: { type: Number, default: null },
  inputHeight: { type: Number, default: null },
  outputWidth: { type: Number, default: null },
  outputHeight: { type: Number, default: null },
  outputFormat: { type: String, default: null },
  message: { type: String, default: null },
  artifactId: { type: String, default: null },
}, { _id: false });

const JobSchema = new Schema<JobDoc>({
  _id: { type: String, default: () => randomUUID() },
  sessionId: { type: String, required: true, index: true },
  kind: { type: String, enum: ["image.optimize", "css.font-display", "asset.analyze", "site.audit"], required: true },
  status: { type: String, enum: ["completed", "partial", "failed"], required: true },
  label: { type: String, required: true, maxlength: 180 },
  fileCount: { type: Number, required: true, min: 0 },
  inputBytes: { type: Number, required: true, min: 0 },
  outputBytes: { type: Number, required: true, min: 0 },
  savedBytes: { type: Number, required: true },
  note: { type: String, default: null, maxlength: 1000 },
  items: { type: [JobItemSchema], default: [] },
  createdAt: { type: Date, default: Date.now, index: true },
}, { versionKey: false, collection: "optiweb_jobs" });
JobSchema.index({ sessionId: 1, createdAt: -1 });
JobSchema.index({ sessionId: 1, kind: 1, status: 1, createdAt: -1 });

const ArtifactSchema = new Schema<ArtifactDoc>({
  _id: { type: String, required: true },
  jobId: { type: String, required: true, index: true },
  sessionId: { type: String, required: true, index: true },
  filename: { type: String, required: true, maxlength: 240 },
  itemFilename: { type: String, required: true, maxlength: 240 },
  contentType: { type: String, required: true, maxlength: 140 },
  byteSize: { type: Number, required: true, min: 0 },
  kind: { type: String, required: true, maxlength: 32 },
  data: { type: Buffer, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
}, { versionKey: false, collection: "optiweb_artifacts" });
ArtifactSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ArtifactSchema.index({ sessionId: 1, createdAt: -1 });

const PreferenceSchema = new Schema<PreferenceDoc>({
  sessionId: { type: String, required: true, unique: true },
  defaultImageFormat: { type: String, enum: ["webp", "avif", "jpeg", "png", "original"], default: "webp" },
  defaultQuality: { type: Number, min: 1, max: 100, default: 78 },
  defaultMaxWidth: { type: Number, min: 1, default: null },
  fontDisplayPolicy: { type: String, enum: ["auto", "block", "swap", "fallback", "optional"], default: "swap" },
  analyzerThresholdKb: { type: Number, min: 50, max: 10000, default: 300 },
  reduceMotion: { type: Boolean, default: false },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false, collection: "optiweb_preferences" });

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}
const Job = model<JobDoc>("OptiwebJob", JobSchema);
const Artifact = model<ArtifactDoc>("OptiwebArtifact", ArtifactSchema);
const Preference = model<PreferenceDoc>("OptiwebPreference", PreferenceSchema);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean { return UUID_PATTERN.test(value); }
function ttlDate(from = new Date()): Date { return new Date(from.getTime() + limits.artifactTtlHours * 60 * 60 * 1000); }
function preferencesFrom(doc: PreferenceDoc): Preferences {
  return {
    defaultImageFormat: doc.defaultImageFormat,
    defaultQuality: doc.defaultQuality,
    defaultMaxWidth: doc.defaultMaxWidth,
    fontDisplayPolicy: doc.fontDisplayPolicy,
    analyzerThresholdKb: doc.analyzerThresholdKb,
    reduceMotion: Boolean(doc.reduceMotion),
    updatedAt: doc.updatedAt?.toISOString() ?? null,
  };
}

export async function pruneExpiredArtifacts(): Promise<void> {
  await connectMongo();
  await Artifact.deleteMany({ expiresAt: { $lte: new Date() } });
}

export async function persistJob(params: {
  sessionId: string;
  kind: JobKind;
  status: JobStatus;
  label: string;
  fileCount: number;
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  note?: string | null;
  items: PersistItem[];
}): Promise<{ jobId: string | null; artifacts: Map<string, string>; persisted: boolean }> {
  const artifacts = new Map<string, string>();
  let createdJobId: string | null = null;
  try {
    await connectMongo();
    const now = new Date();
    const jobId = randomUUID();
    createdJobId = jobId;
    const prepared = params.items.map((item) => ({ id: randomUUID(), item }));
    const items: JobItemDoc[] = prepared.map(({ id, item }) => ({
      id,
      filename: item.filename,
      outputFilename: item.outputFilename ?? null,
      status: item.status,
      inputBytes: item.inputBytes,
      outputBytes: item.outputBytes,
      savedBytes: item.savedBytes,
      savingsPercent: item.savingsPercent,
      inputWidth: item.inputWidth ?? null,
      inputHeight: item.inputHeight ?? null,
      outputWidth: item.outputWidth ?? null,
      outputHeight: item.outputHeight ?? null,
      outputFormat: item.outputFormat ?? null,
      message: item.message ?? null,
      artifactId: item.artifact ? id : null,
    }));
    const job = await Job.create({
      _id: jobId,
      sessionId: params.sessionId,
      kind: params.kind,
      status: params.status,
      label: params.label,
      fileCount: params.fileCount,
      inputBytes: params.inputBytes,
      outputBytes: params.outputBytes,
      savedBytes: params.savedBytes,
      note: params.note ?? null,
      items,
      createdAt: now,
    });
    const artifactDocs = prepared.filter(({ item }) => Boolean(item.artifact)).map(({ id, item }) => {
      const artifact = item.artifact as NonNullable<PersistItem["artifact"]>;
      artifacts.set(id, artifact.filename);
      return {
        _id: id,
        jobId: job._id,
        sessionId: params.sessionId,
        filename: artifact.filename,
        itemFilename: item.filename,
        contentType: artifact.contentType,
        byteSize: artifact.data.byteLength,
        kind: artifact.kind,
        data: artifact.data,
        createdAt: now,
        expiresAt: ttlDate(now),
      };
    });
    if (artifactDocs.length) await Artifact.insertMany(artifactDocs, { ordered: true });
    return { jobId: job._id, artifacts, persisted: true };
  } catch (error) {
    // Avoid orphaning metadata if artifact insertion fails after the job document
    // was created. TTL cleanup is only a backup; this is the immediate rollback.
    try {
      if (createdJobId) {
        await Artifact.deleteMany({ jobId: createdJobId, sessionId: params.sessionId });
        await Job.deleteOne({ _id: createdJobId, sessionId: params.sessionId });
      }
    } catch {
      // Preserve the original persistence failure; periodic TTL cleanup remains active.
    }
    console.error("[storage] MongoDB persistence unavailable:", error instanceof Error ? error.message : "unknown error");
    return { jobId: null, artifacts: new Map(), persisted: false };
  }
}

export async function listHistory(
  sessionId: string,
  query: { q?: string; kind: string; status: string; sort: string; page: number; pageSize: number },
): Promise<HistoryPage> {
  await connectMongo();
  const filter: FilterQuery<JobDoc> = { sessionId };
  if (query.kind !== "all") filter.kind = query.kind;
  if (query.status !== "all") filter.status = query.status;
  if (query.q) filter.label = { $regex: query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  const sort: Record<string, 1 | -1> = query.sort === "oldest" ? { createdAt: 1 } : query.sort === "saved" ? { savedBytes: -1 } : { createdAt: -1 };
  const page = Math.max(1, query.page);
  const pageSize = Math.min(50, Math.max(5, query.pageSize));
  const [rows, total] = await Promise.all([
    Job.find(filter).sort(sort).skip((page - 1) * pageSize).limit(pageSize).lean<JobDoc[]>(),
    Job.countDocuments(filter),
  ]);
  const entries: HistoryEntry[] = rows.map((row) => ({
    id: row._id,
    kind: row.kind,
    status: row.status,
    label: row.label,
    fileCount: row.fileCount,
    inputBytes: Number(row.inputBytes),
    outputBytes: Number(row.outputBytes),
    savedBytes: Number(row.savedBytes),
    savingsPercent: row.inputBytes > 0 ? (row.savedBytes / row.inputBytes) * 100 : null,
    note: row.note,
    createdAt: new Date(row.createdAt).toISOString(),
    itemCount: row.items.length,
    artifactIds: row.items.filter((item) => Boolean(item.artifactId)).map((item) => item.artifactId as string),
  }));
  return { entries, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getJobDetail(sessionId: string, jobId: string) {
  if (!isUuid(jobId)) return null;
  await connectMongo();
  const job = await Job.findOne({ _id: jobId, sessionId }).lean<JobDoc | null>();
  if (!job) return null;
  return { job, items: job.items };
}

export async function getArtifact(sessionId: string, artifactId: string) {
  if (!isUuid(artifactId)) return null;
  await connectMongo();
  const doc = await Artifact.findOne({ _id: artifactId, sessionId, expiresAt: { $gt: new Date() } }).lean<ArtifactDoc | null>();
  if (!doc) return null;
  return { ...doc, data: Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data as unknown as Uint8Array) };
}

export async function getArtifactsByIds(sessionId: string, ids: string[]) {
  const valid = ids.filter(isUuid).slice(0, limits.maxFilesPerRequest);
  if (!valid.length) return [];
  await connectMongo();
  const rows = await Artifact.find({ _id: { $in: valid }, sessionId, expiresAt: { $gt: new Date() } })
    .select({ _id: 1, filename: 1, contentType: 1, data: 1 }).lean<Array<Pick<ArtifactDoc, "filename" | "contentType" | "data"> & { _id: string }>>();
  return rows.map((row) => ({ id: row._id, filename: row.filename, contentType: row.contentType, data: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data as unknown as Uint8Array) }));
}

export async function deleteJob(sessionId: string, jobId: string): Promise<boolean> {
  if (!isUuid(jobId)) return false;
  await connectMongo();
  const job = await Job.findOne({ _id: jobId, sessionId }).lean<JobDoc | null>();
  if (!job) return false;
  const ids = job.items.map((item) => item.artifactId).filter((id): id is string => Boolean(id));
  if (ids.length) await Artifact.deleteMany({ _id: { $in: ids }, sessionId });
  await Job.deleteOne({ _id: jobId, sessionId });
  return true;
}

export async function clearSessionHistory(sessionId: string): Promise<number> {
  await connectMongo();
  const jobs = await Job.find({ sessionId }).select({ _id: 1, "items.artifactId": 1 }).lean<Array<{ _id: string; items: Array<{ artifactId?: string | null }> }>>();
  const ids = jobs.flatMap((job) => job.items.map((item) => item.artifactId).filter((id): id is string => Boolean(id)));
  if (ids.length) await Artifact.deleteMany({ _id: { $in: ids }, sessionId });
  const result = await Job.deleteMany({ sessionId });
  return result.deletedCount ?? 0;
}

export async function sessionSummary(sessionId: string) {
  await connectMongo();
  const [row] = await Job.aggregate<{ jobs: number; savedBytes: number; inputBytes: number; files: number; completed: number }>([
    { $match: { sessionId } },
    { $group: {
      _id: null,
      jobs: { $sum: 1 },
      savedBytes: { $sum: "$savedBytes" },
      inputBytes: { $sum: "$inputBytes" },
      files: { $sum: "$fileCount" },
      completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
    } },
  ]);
  return { jobs: row?.jobs ?? 0, savedBytes: row?.savedBytes ?? 0, inputBytes: row?.inputBytes ?? 0, files: row?.files ?? 0, completed: row?.completed ?? 0 };
}

export async function getPreferences(sessionId: string): Promise<Preferences | null> {
  try {
    await connectMongo();
    const row = await Preference.findOne({ sessionId }).lean<PreferenceDoc | null>();
    return row ? preferencesFrom(row) : null;
  } catch {
    return null;
  }
}

export async function savePreferences(sessionId: string, next: Preferences): Promise<Preferences> {
  await connectMongo();
  const row = await Preference.findOneAndUpdate(
    { sessionId },
    { $set: {
      defaultImageFormat: next.defaultImageFormat,
      defaultQuality: next.defaultQuality,
      defaultMaxWidth: next.defaultMaxWidth,
      fontDisplayPolicy: next.fontDisplayPolicy,
      analyzerThresholdKb: next.analyzerThresholdKb,
      reduceMotion: Boolean(next.reduceMotion),
      updatedAt: new Date(),
    } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean<PreferenceDoc | null>();
  if (!row) throw new Error("Could not save preferences.");
  return preferencesFrom(row);
}

export type { ImageResult };
