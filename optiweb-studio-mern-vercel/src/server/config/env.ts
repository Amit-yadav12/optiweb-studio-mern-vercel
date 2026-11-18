/**
 * Central runtime configuration. Every limit used by the processing pipeline is
 * declared here so the numbers in the UI copy and the numbers enforced by the
 * server can never drift apart.
 *
 * There are two sets of limits, because files reach the server in two ways:
 *
 *  - `limits`: files sent inside the request to a serverless function. The
 *    host caps the whole request body (4.5 MB on Vercel), so these values are
 *    small and have fixed ceilings that the environment cannot raise.
 *  - `capacity`: files uploaded by the browser directly to object storage and
 *    processed by a background job. These are the application's real capacity
 *    and are only in effect when object storage and the database are available.
 */

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** A positive number from the environment, never above `ceiling`. */
function capped(value: string | undefined, fallback: number, ceiling: number): number {
  return Math.min(num(value, fallback), ceiling);
}

const MB = 1024 * 1024;

export const APP_NAME = "OptiWeb Studio";
export const APP_TAGLINE = "Make every byte count.";

/**
 * Limits for files that travel inside a function request (multipart upload,
 * buffered response). The ceilings come from the hosts' body limits, 4.5 MB on
 * Vercel and 6 MB with Base64 overhead on Netlify, so `OW_REQUEST_*` can lower
 * a value but not raise it above its ceiling.
 */
export const limits = {
  /** Hard cap for a single uploaded file, in bytes. */
  maxFileBytes: capped(process.env.OW_REQUEST_MAX_FILE_MB, 1, 3.8) * MB,
  /**
   * Hard cap for the sum of all file bodies in one request.
   *
   * Serverless hosts cap the entire request body rather than each file. This
   * budget leaves headroom for multipart framing and fields.
   */
  maxBatchBytes: capped(process.env.OW_REQUEST_MAX_BATCH_MB, 3.8, 3.8) * MB,
  /** Files accepted per request. */
  maxFilesPerRequest: Math.floor(capped(process.env.OW_REQUEST_MAX_FILES, 4, 10)),
  /** Wall-clock budget for one image transform. */
  imageTimeoutMs: num(process.env.OW_IMAGE_TIMEOUT_MS, 15_000),
  /** Parallel sharp transforms per request. */
  imageConcurrency: num(process.env.OW_IMAGE_CONCURRENCY, 2),
  /**
   * Maximum decoded pixel count (width × height × frames). Caps decompression
   * bombs independently of compressed file size — a 200 KB PNG can still decode
   * to a 50 000 × 50 000 raster.
   */
  maxDecodedPixels: capped(process.env.OW_REQUEST_MAX_DECODED_PIXELS, 24_000_000, 40_000_000),
  /**
   * Max characters of CSS accepted by the font tools. CSS travels as JSON in
   * the request body, so 1 MB of text stays well below the body limit.
   */
  maxCssChars: Math.floor(capped(process.env.OW_MAX_CSS_MB, 1, 2) * MB),
  /** Files accepted by one asset analysis request. Their combined size is bounded by `maxBatchBytes`. */
  maxAssetFiles: Math.floor(capped(process.env.OW_MAX_ASSET_FILES, 10, 10)),
  /** Maximum single artifact size, kept below serverless response-body limits. */
  maxArtifactBytes: capped(process.env.OW_REQUEST_MAX_ARTIFACT_MB, 3.5, 3.5) * MB,
  /**
   * Hard cap for a generated ZIP that is buffered into one response. It stays
   * below the hosts' response limits, including Base64 overhead on Netlify.
   */
  maxZipBytes: capped(process.env.OW_REQUEST_MAX_ZIP_MB, 3.5, 3.5) * MB,
  /**
   * Combined size of the output files one response may carry when they could
   * not be stored (see `inlineOutput`). Base64 adds a third and the whole JSON
   * response has to stay below the smallest serverless response limit, 4.5 MB
   * on Vercel, so the environment can lower this value but not raise it.
   */
  maxInlineBytes: Math.min(num(process.env.OW_MAX_INLINE_MB, 3), 3) * 1024 * 1024,
  /** Artifact retention window. */
  artifactTtlHours: num(process.env.OW_ARTIFACT_TTL_HOURS, 720),
  /** MongoDB pool size. Keep small on serverless (1–3). */
  mongoPoolMax: num(process.env.OW_MONGO_POOL_MAX, 3),
  /** Website audit: max HTML bytes. */
  auditMaxHtmlBytes: num(process.env.OW_AUDIT_MAX_HTML_KB, 700) * 1024,
  /** Website audit: max bytes per discovered resource. */
  auditMaxResourceBytes: num(process.env.OW_AUDIT_MAX_RESOURCE_KB, 400) * 1024,
  /** Website audit: max resources fetched after the document. */
  auditMaxResources: Math.min(num(process.env.OW_AUDIT_MAX_RESOURCES, 16), 32),
  /** Website audit: per-request timeout. */
  auditTimeoutMs: Math.min(num(process.env.OW_AUDIT_TIMEOUT_MS, 4_000), 8_000),
  /** Website audit: overall request budget, kept below a typical serverless execution ceiling. */
  auditTotalTimeoutMs: Math.min(num(process.env.OW_AUDIT_TOTAL_TIMEOUT_MS, 45_000), 50_000),
  /** Website audit: maximum time reserved for optional PageSpeed Insights. */
  auditPageSpeedTimeoutMs: Math.min(num(process.env.OW_AUDIT_PAGESPEED_TIMEOUT_MS, 10_000), 12_000),
  /** Optional extra same-origin pages (depth 1). */
  auditMaxPages: Math.min(num(process.env.OW_AUDIT_MAX_PAGES, 1), 3),
} as const;

/**
 * Ceilings of the standard capacity mode. `OW_MAX_*` can lower a value but not
 * raise it above its ceiling: a higher number would be a claim about memory,
 * time and storage that has not been load-tested in the deployed runtime.
 */
const STANDARD_CEILING = {
  fileMb: 25,
  files: 10,
  batchMb: 150,
  decodedPixels: 40_000_000,
  jobPixels: 160_000_000,
  artifactMb: 50,
  zipMb: 250,
} as const;

/**
 * Advanced capacity mode (50 MB files, 20 files, 500 MB batches, 50 MP) is not
 * available in this release. `OW_LARGE_CAPACITY_ENABLED` is read so that the
 * request is visible in `/api/v1/limits`, but it raises nothing: the ceilings
 * above stay in force until the larger sizes have been load-tested on the
 * deployed runtime with a durable queue.
 */
export const advancedCapacity = {
  requested: /^(1|true|yes|on)$/i.test(process.env.OW_LARGE_CAPACITY_ENABLED ?? ""),
  enabled: false,
  reason: "Advanced capacity has not been load-tested on the deployed runtime, so the standard limits stay in force.",
} as const;

/**
 * Capacity of the direct-upload pipeline: the browser uploads to object
 * storage, and a background job processes the files. In effect only when
 * object storage and the database are both available; otherwise the smaller
 * request limits above apply and the API says so in `/api/v1/limits`.
 */
export const capacity = {
  /** Largest single source file. */
  maxFileBytes: capped(process.env.OW_MAX_FILE_MB, STANDARD_CEILING.fileMb, STANDARD_CEILING.fileMb) * MB,
  /** Files per job. */
  maxFiles: Math.floor(capped(process.env.OW_MAX_FILES, STANDARD_CEILING.files, STANDARD_CEILING.files)),
  /** Combined size of the source files of one job. */
  maxBatchBytes: capped(process.env.OW_MAX_BATCH_MB, STANDARD_CEILING.batchMb, STANDARD_CEILING.batchMb) * MB,
  /** Decoded pixels (width × height × frames) of one image. */
  maxDecodedPixels: Math.floor(capped(process.env.OW_MAX_DECODED_PIXELS, STANDARD_CEILING.decodedPixels, STANDARD_CEILING.decodedPixels)),
  /** Decoded pixels of all images of one job together. */
  maxJobPixels: Math.floor(capped(process.env.OW_MAX_TOTAL_BATCH_PIXELS, STANDARD_CEILING.jobPixels, STANDARD_CEILING.jobPixels)),
  /** Largest generated file. */
  maxArtifactBytes: capped(process.env.OW_MAX_ARTIFACT_MB, STANDARD_CEILING.artifactMb, STANDARD_CEILING.artifactMb) * MB,
  /** Largest ZIP download. It is streamed, never buffered. */
  maxZipBytes: capped(process.env.OW_MAX_ZIP_MB, STANDARD_CEILING.zipMb, STANDARD_CEILING.zipMb) * MB,
  /** Wall-clock budget for one encode of one image inside a job. */
  imageTimeoutMs: Math.floor(capped(process.env.OW_JOB_IMAGE_TIMEOUT_MS, 120_000, 240_000)),
  /**
   * Largest AVIF output, in pixels. AVIF encoding needs far more memory and
   * time than the other formats: a 40 MP image took about 1.4 GB and a minute
   * on one core in testing, which does not fit a 2 GB function. Larger images
   * can still be written as WebP, JPEG or PNG, or resized first.
   */
  avifMaxPixels: Math.floor(capped(process.env.OW_AVIF_MAX_PIXELS, 16_000_000, 24_000_000)),
  /** Above this many pixels, the multi-candidate policies skip the AVIF candidate, which is the slowest encode. */
  avifCandidateMaxPixels: Math.floor(num(process.env.OW_AVIF_CANDIDATE_MAX_PIXELS, 12_000_000)),
  /** How long an upload authorization stays valid. */
  uploadTokenTtlMs: Math.floor(capped(process.env.OW_UPLOAD_TOKEN_TTL_MINUTES, 20, 60) * 60_000),
  /** Source uploads are deleted this long after their job finished. */
  sourceTtlMs: Math.floor(num(process.env.OW_SOURCE_TTL_HOURS, 24) * 3_600_000),
  /** Generated files are deleted this long after they were created. */
  artifactTtlMs: Math.floor(num(process.env.OW_ARTIFACT_TTL_HOURS, 720) * 3_600_000),
  /** Job records (History) are deleted this long after they were created. */
  historyTtlMs: Math.floor(num(process.env.OW_HISTORY_TTL_DAYS, 180) * 86_400_000),
  /** Storage one guest session may hold: sources, generated files and uploads in progress. */
  sessionQuotaBytes: Math.floor(num(process.env.OW_SESSION_STORAGE_QUOTA_MB, 500) * MB),
  /** Unfinished jobs one session may have at a time. */
  maxActiveJobs: Math.floor(num(process.env.OW_MAX_ACTIVE_JOBS_PER_SESSION, 2)),
  /** Retries of one file after a retryable failure (so `n + 1` attempts in total). */
  maxItemRetries: Math.floor(capped(process.env.OW_MAX_JOB_RETRIES, 2, 5)),
  /**
   * Cost controls for the whole application. Uploads are refused once all
   * sessions together hold this much, or have uploaded this much today.
   */
  globalStorageBudgetBytes: Math.floor(num(process.env.OW_GLOBAL_STORAGE_BUDGET_MB, 2048) * MB),
  globalDailyUploadBytes: Math.floor(num(process.env.OW_GLOBAL_DAILY_UPLOAD_MB, 4096) * MB),
  /** Share of a budget at which usage is reported as a warning. */
  warnAtFraction: 0.8,
  /** A worker's claim on a job. Another worker may take the job once it lapses. */
  jobLeaseMs: Math.floor(capped(process.env.OW_JOB_LEASE_SECONDS, 150, 900) * 1000),
  /** How long one worker invocation keeps taking work. Must stay below the function's maximum duration. */
  workerBudgetMs: Math.floor(capped(process.env.OW_WORKER_BUDGET_SECONDS, 240, 780) * 1000),
  /** A job whose uploads have not finished after this long is cancelled. */
  uploadPhaseTtlMs: Math.floor(num(process.env.OW_UPLOAD_PHASE_TTL_MINUTES, 120) * 60_000),
} as const;

export const optimizationPolicies = ["single", "best-effort", "no-regression", "target-size"] as const;
export type OptimizationPolicy = (typeof optimizationPolicies)[number];

export const imageFormats = ["webp", "avif", "jpeg", "png", "original"] as const;
export type ImageFormat = (typeof imageFormats)[number];

/** Content types accepted by the image pipeline (verified per file by sharp). */
export const imageAccept = {
  mime: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/avif",
    "image/gif",
    "image/tiff",
    "image/svg+xml",
  ],
  extensions: [".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".tif", ".tiff"],
} as const;

/** Raster formats sharp can re-encode from a raster source. */
export const rasterAccept = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/tiff",
] as const;

export const fontDisplayValues = ["auto", "block", "swap", "fallback", "optional"] as const;
export type FontDisplayPolicy = (typeof fontDisplayValues)[number];

export type RateLimitBucket = keyof typeof rateLimits;

export const rateLimits = {
  "images/optimize": { capacity: 20, windowMs: 60_000 },
  // Direct-upload pipeline. These buckets are also counted in the database,
  // so the limit holds across serverless instances.
  "jobs/create": { capacity: 12, windowMs: 60_000 },
  "uploads/token": { capacity: 120, windowMs: 60_000 },
  "uploads/complete": { capacity: 120, windowMs: 60_000 },
  "jobs/read": { capacity: 240, windowMs: 60_000 },
  "jobs/control": { capacity: 30, windowMs: 60_000 },
  usage: { capacity: 60, windowMs: 60_000 },
  "css/analyze": { capacity: 60, windowMs: 60_000 },
  "assets/analyze": { capacity: 30, windowMs: 60_000 },
  audits: { capacity: 10, windowMs: 60_000 },
  history: { capacity: 120, windowMs: 60_000 },
  artifacts: { capacity: 120, windowMs: 60_000 },
  preferences: { capacity: 60, windowMs: 60_000 },
} as const;

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
