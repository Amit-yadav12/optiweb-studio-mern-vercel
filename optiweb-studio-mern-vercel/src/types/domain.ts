/** Shared client/server domain types for OptiWeb Studio. */
import type { FontDisplayPolicy, ImageFormat, OptimizationPolicy } from "@/server/config/env";
export type { FontDisplayPolicy, ImageFormat, OptimizationPolicy };

export type JobKind = "image.optimize" | "css.font-display" | "asset.analyze" | "site.audit";
export type JobStatus = "completed" | "partial" | "failed";

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

export type ImageResult = ImageMetrics & {
  id: string;
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
  jobId: string;
  /** False when history storage is unavailable: results are returned but not downloadable later. */
  persisted: boolean;
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

export type HealthStatus = {
  ok: boolean;
  service: string;
  version: string;
  database: { connected: boolean; latencyMs: number | null; error?: string };
  sharp: { available: boolean; versions?: string };
  uptimeSeconds: number;
  timestamp: string;
};
