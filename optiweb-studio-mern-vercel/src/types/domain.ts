/** Shared client/server domain types for OptiWeb Studio. */
import type { FontDisplayPolicy, ImageFormat, OptimizationPolicy } from "../server/config/env.js";
export type { FontDisplayPolicy, ImageFormat, OptimizationPolicy };

export type JobKind = "image.optimize" | "css.font-display" | "asset.analyze" | "site.audit";
export type JobStatus = "completed" | "partial" | "failed";

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
  status: JobStatus;
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
