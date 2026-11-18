/** Shared client/server domain types for OptiWeb Studio. */
import type { FontDisplayPolicy, ImageFormat, OptimizationPolicy } from "../server/config/env.js";
export type { FontDisplayPolicy, ImageFormat, OptimizationPolicy };

export type JobKind = "image.optimize" | "css.font-display" | "asset.analyze" | "site.audit";
export type JobStatus = "completed" | "partial" | "failed";

/**
 * State of a background job of the direct-upload pipeline.
 *
 *  created     the job exists; no file has been authorized for upload yet
 *  uploading   the browser is uploading files to object storage
 *  uploaded    every file has arrived and passed the upload checks
 *  queued      handed to the worker; waiting to be picked up
 *  processing  a worker holds the job and is converting files
 *  completed   every file was converted
 *  partial     some files were converted, some failed
 *  failed      no file was converted
 *  cancelled   stopped on request, or abandoned before its uploads finished
 */
export type JobState = "created" | "uploading" | "uploaded" | "queued" | "processing" | "completed" | "partial" | "failed" | "cancelled";

/** State of one file of a background job. */
export type JobItemState = "awaiting_upload" | "uploaded" | "processing" | "completed" | "failed" | "cancelled";

/**
 * Why a storage operation failed. The list is closed: the server maps every
 * database error onto one of these and never sends the error itself.
 */
export type StorageFailureCategory =
  /** No connection string in the server environment. */
  | "not_configured"
  /** The connection string cannot be parsed. */
  | "invalid_uri"
  /** The database host name does not resolve. */
  | "dns_failure"
  /** The database rejected the user name or password. */
  | "authentication_failed"
  /** A server was reached but dropped the connection before authentication, as an IP access list does. */
  | "network_access_denied"
  /** Nothing is listening at the database address. */
  | "connection_refused"
  /** No database server answered before the server-selection timeout. */
  | "server_selection_timeout"
  /** The connection failed for a reason outside the categories above. */
  | "connection_failed"
  /** An established connection dropped during an operation. */
  | "connection_lost"
  /** The database user is authenticated but not allowed to run the operation. */
  | "permission_denied"
  /** A document, such as the job record, could not be written. */
  | "write_failed"
  /** The job record was written but its output files could not be inserted. */
  | "artifact_insert_failed"
  /** A query failed on an established connection. */
  | "read_failed";

/** A storage failure in fixed wording that is safe to show to anyone. */
export type StorageFailure = { category: StorageFailureCategory; message: string; hint: string };

/**
 * Whether the result of a request was stored.
 *
 * `persisted: true` means the job is in History and its output files can be
 * downloaded by URL. When it is false, nothing was kept: there is no history
 * entry and no stored download, and the remaining fields say why. The image
 * optimizer then sends the converted files in the response (`inlineOutput`).
 */
export type StorageOutcome = { persisted: true } | ({ persisted: false } & StorageFailure);

export type ImageOptimizeSettings = {
  format: ImageFormat;
  quality: number;
  maxWidth: number | null;
  maxHeight: number | null;
  policy?: OptimizationPolicy;
  targetBytes?: number | null;
};

export type CandidateRecord = {
  format: string;
  quality: number;
  bytes: number;
  selected: boolean;
  note: string;
};

export type ImageMetrics = {
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  savingsPercent: number;
  inputWidth: number | null;
  inputHeight: number | null;
  outputWidth: number | null;
  outputHeight: number | null;
  outputFormat: string;
};

/**
 * An output file sent inside the response, because it could not be stored.
 *
 * The browser can save it from the page that received the response. It is not
 * a stored download: the server keeps no copy, no URL serves it, and it is not
 * in History.
 */
export type InlineOutput = {
  encoding: "base64";
  /** MIME type of the produced bytes. */
  contentType: string;
  /** Size of the decoded file. Equals the result's `outputBytes`. */
  bytes: number;
  /** The file, Base64-encoded with padding. */
  data: string;
};

export type ImageResult = ImageMetrics & {
  /** Identifies the result within this response. It is not a download ID; see `artifactId`. */
  id: string;
  /** ID of the stored output file, or null when the file was not converted or not stored. */
  artifactId: string | null;
  /**
   * The output file itself, sent only when it was converted but not stored.
   * Absent or null when the file is stored (use `artifactId`), was not
   * converted, or did not fit in the response (`inlineSkipped`).
   */
  inlineOutput?: InlineOutput | null;
  /** Set when an unstored output file is not in the response: the outputs of the batch exceed the response size limit. */
  inlineSkipped?: "too_large";
  /** Name of the uploaded source file (sanitised). */
  filename: string;
  /** Name of the produced file, e.g. "hero-optiweb.webp". */
  outputFilename: string;
  status: "completed" | "failed";
  /** Short, safe error code — never a raw exception message. */
  errorCode?: string;
  message?: string;
  inputContentType: string;
  durationMs: number;
  policy?: OptimizationPolicy;
  candidates?: CandidateRecord[];
  retainedOriginal?: boolean;
  targetBytes?: number | null;
  targetMet?: boolean | null;
};

export type ImageOptimizeResponse = {
  /** History ID of the stored job. Empty when `persisted` is false. */
  jobId: string;
  /** Same value as `storage.persisted`. False means no history entry and no stored downloads exist. */
  persisted: boolean;
  /** Storage result, with the failure category and safe wording when nothing was stored. */
  storage: StorageOutcome;
  /** Conversion result: `failed` means no file was converted, `partial` means some were. */
  status: JobStatus;
  results: ImageResult[];
  totals: { inputBytes: number; outputBytes: number; savedBytes: number; savingsPercent: number };
};

/* ------------------------------------------------ direct-upload pipeline */

export type ImageJobItemResult = ImageMetrics & {
  outputFilename: string;
  durationMs: number;
  /** True when the no-regression policy kept the source bytes. */
  retainedOriginal: boolean;
};

/** One file of a background job. */
export type ImageJobItem = {
  /** Also the upload ID of the file. */
  id: string;
  index: number;
  /** Sanitised name of the source file. */
  filename: string;
  state: JobItemState;
  /** Size of the source file. */
  bytes: number;
  /** Times a worker has started this file. */
  attempts: number;
  /** Short, fixed code when the file failed or was cancelled. Never a raw exception message. */
  errorCode: string | null;
  message: string | null;
  /** True when retrying may succeed: the failure was temporary and the source file is still stored. */
  retryable: boolean;
  /** Measured result, when the file was converted. */
  result: ImageJobItemResult | null;
  /** ID of the generated file, served by `GET /api/v1/artifacts/:id`. Null until the file is converted. */
  artifactId: string | null;
  /** False once the generated file has been deleted from storage. The record stays in History. */
  artifactAvailable: boolean;
  artifactExpiresAt: string | null;
};

/** A background image job. Counts are real completion counts, never an estimate of progress. */
export type ImageJob = {
  id: string;
  state: JobState;
  settings: ImageOptimizeSettings;
  /** A cancellation was requested and the worker has not stopped yet. */
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  uploadedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Uploads must finish before this time, or the job is cancelled. */
  uploadDeadline: string;
  counts: {
    total: number;
    awaitingUpload: number;
    /** Uploaded and waiting for the worker. */
    waiting: number;
    processing: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  /** Sums over the converted files. */
  totals: { inputBytes: number; outputBytes: number; savedBytes: number; savingsPercent: number | null };
  items: ImageJobItem[];
};

/** What the browser needs to upload one file straight to object storage. */
export type UploadGrantView = {
  uploadId: string;
  /** Content type the upload must be sent with. */
  contentType: string;
  /** Exact size the upload must have. */
  bytes: number;
  /** After this time the grant is useless; request a new one. */
  expiresAt: string;
} & (
  | { transport: "vercel-blob"; pathname: string; clientToken: string; access: "private"; multipart: boolean }
  | { transport: "local"; uploadUrl: string }
);

export type CreateImageJobResponse = {
  job: ImageJob;
  /** True when the idempotency key matched an existing job and nothing new was created. */
  replayed: boolean;
};

/** How files reach the server on this deployment. */
export type UploadMode =
  /** The browser uploads to object storage and a background job processes the files. */
  | "direct"
  /** Files are sent inside the request; the smaller request limits apply. */
  | "request";

/** Limits of the Image Optimizer in the mode that is in effect. */
export type ImageCapacity = {
  mode: UploadMode;
  /** Why direct uploads are not in effect. Null in direct mode. */
  directUnavailableReason: string | null;
  maxFileBytes: number;
  maxFiles: number;
  maxBatchBytes: number;
  maxDecodedPixels: number;
  /** Decoded pixels of all files of one job together. Null in request mode. */
  maxJobPixels: number | null;
  maxArtifactBytes: number;
  maxZipBytes: number;
  /** Largest AVIF output in pixels. Null when there is no separate limit. */
  avifMaxPixels: number | null;
  sessionQuotaBytes: number | null;
  maxActiveJobs: number | null;
  sourceTtlHours: number | null;
  artifactTtlHours: number;
  historyTtlDays: number | null;
};

/** Storage and activity of the current session, with the limits that apply to it. */
export type UsageSummary = {
  /** False when the direct-upload pipeline is not available; all numbers are then zero. */
  available: boolean;
  quotaBytes: number;
  usedBytes: number;
  remainingBytes: number;
  /** Bytes held for uploads that have not finished. */
  reservedBytes: number;
  sourceBytes: number;
  artifactBytes: number;
  /** True at or above the warning threshold of the quota. */
  nearQuota: boolean;
  activeJobs: number;
  maxActiveJobs: number;
  files: { sources: number; artifacts: number };
  /** Generated files that will be deleted within the next three days. */
  expiringSoon: Array<{ artifactId: string; filename: string; bytes: number; expiresAt: string; jobId: string }>;
  lifetime: { uploads: number; uploadBytes: number; jobs: number; failedJobs: number; outputBytes: number };
  recentJobs: Array<{ id: string; state: JobState; createdAt: string; files: number; inputBytes: number; savedBytes: number }>;
  retention: { sourceHours: number; artifactHours: number; historyDays: number };
};

export type CssFindingSeverity = "info" | "warning" | "issue";

export type CssFinding = {
  id: string;
  severity: CssFindingSeverity;
  /** short|detail */
  code: string;
  title: string;
  detail: string;
  line?: number;
  selector?: string;
};

export type CssAnalysis = {
  fontFaceCount: number;
  withFontDisplay: number;
  missingFontDisplay: number;
  malformed: number;
  findings: CssFinding[];
  parseErrors: Array<{ line: number; reason: string }>;
  policy: FontDisplayPolicy;
};

export type CssPatchResponse = {
  jobId: string;
  artifactId: string | null;
  persisted: boolean;
  storage: StorageOutcome;
  output: string;
  inputBytes: number;
  outputBytes: number;
  changedLines: number[];
  rulesPatched: Array<{ family: string | null; line: number; value: string }>;
  analysis: CssAnalysis;
};

export type AssetFinding = {
  id: string;
  filename: string;
  severity: CssFindingSeverity;
  /** Deterministic heuristic id so the UI can group and explain findings. */
  code:
    | "large-file"
    | "oversized-dimensions"
    | "format-conversion"
    | "png-for-photo"
    | "svg-not-processed"
    | "font-display-missing"
    | "css-syntax"
    | "no-findings";
  evidence: string;
  recommendation: string;
  heuristic: boolean;
};

export type AssetAnalysisFile = {
  id: string;
  filename: string;
  contentType: string;
  bytes: number;
  kind: "image" | "css" | "other";
  width: number | null;
  height: number | null;
  format: string | null;
  findings: AssetFinding[];
  artifactId?: string;
  error?: string;
};

export type AssetAnalysisResponse = {
  jobId: string;
  persisted: boolean;
  storage: StorageOutcome;
  files: AssetAnalysisFile[];
  summary: { filesScanned: number; findings: number; heuristicsUsed: boolean };
};

export type HistoryEntry = {
  id: string;
  kind: JobKind;
  /** `completed`, `partial` or `failed` for finished work; a `JobState` for a background job. */
  status: JobStatus | JobState;
  label: string;
  fileCount: number;
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  savingsPercent: number | null;
  note: string | null;
  createdAt: string;
  itemCount: number;
  artifactIds: string[];
};

export type HistoryPage = {
  entries: HistoryEntry[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export type Preferences = {
  defaultImageFormat: ImageFormat;
  defaultQuality: number;
  defaultMaxWidth: number | null;
  fontDisplayPolicy: FontDisplayPolicy;
  analyzerThresholdKb: number;
  reduceMotion: boolean;
  updatedAt: string | null;
};

/** Database readiness as reported by the health endpoints. Contains no connection details. */
export type DatabaseHealth = {
  /** A connection string is set on the server. */
  configured: boolean;
  /** The database accepted the connection and answered a ping. */
  connected: boolean;
  /** Connected, and the database accepted a read and a write command on the application's job collection. */
  ready: boolean;
  latencyMs: number | null;
  /** Present when `ready` is false. */
  category?: StorageFailureCategory;
  /** Safe, fixed wording for the category. */
  error?: string;
  hint?: string;
};

export type HealthStatus = {
  /** True only when the database is ready. */
  ok: boolean;
  service: string;
  version: string;
  database: DatabaseHealth;
  sharp: { available: boolean; versions?: string };
  uptimeSeconds: number;
  timestamp: string;
};
