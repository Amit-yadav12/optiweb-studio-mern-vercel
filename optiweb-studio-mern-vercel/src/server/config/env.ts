/**
 * Central runtime configuration. Every limit used by the processing pipeline is
 * declared here so the numbers in the UI copy and the numbers enforced by the
 * server can never drift apart.
 */

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const APP_NAME = "OptiWeb Studio";
export const APP_TAGLINE = "Make every byte count.";

export const limits = {
  /** Hard cap for a single uploaded file, in bytes. */
  maxFileBytes: num(process.env.OW_MAX_FILE_MB, 1) * 1024 * 1024,
  /**
   * Hard cap for the sum of all file bodies in one request.
   *
   * Serverless hosts cap the entire request body rather than each file. Vercel Functions
   * reject bodies above 4.5 MB before application code runs. This budget leaves headroom
   * for multipart framing and fields so requests fail in app code, not at the edge.
   */
  maxBatchBytes: num(process.env.OW_MAX_BATCH_MB, 3.8) * 1024 * 1024,
  /** Files accepted per request. */
  maxFilesPerRequest: num(process.env.OW_MAX_FILES, 4),
  /** Wall-clock budget for one image transform. */
  imageTimeoutMs: num(process.env.OW_IMAGE_TIMEOUT_MS, 15_000),
  /** Parallel sharp transforms per request. */
  imageConcurrency: num(process.env.OW_IMAGE_CONCURRENCY, 2),
  /**
   * Maximum decoded pixel count (width × height × frames). Caps decompression
   * bombs independently of compressed file size — a 200 KB PNG can still decode
   * to a 50 000 × 50 000 raster.
   */
  maxDecodedPixels: num(process.env.OW_MAX_DECODED_PIXELS, 24_000_000),
  /** Max characters of CSS accepted by the font tools. */
  maxCssChars: num(process.env.OW_MAX_CSS_CHARS, 400_000),
  /** Maximum single artifact size, kept below serverless response-body limits. */
  maxArtifactBytes: num(process.env.OW_MAX_ARTIFACT_MB, 3.5) * 1024 * 1024,
  /**
   * Hard cap for a generated ZIP. Keep below Vercel’s 4.5 MB function response-body ceiling:
   * serverless responses share the ~4.5 MB payload ceiling with requests.
   */
  maxZipBytes: num(process.env.OW_MAX_ZIP_MB, 3.5) * 1024 * 1024,
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
