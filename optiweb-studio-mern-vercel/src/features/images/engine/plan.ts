/**
 * Planning for the image engine: every decision that needs no pixels.
 *
 * Pure functions only, so the rules can be tested without a browser: output
 * size, the candidates each strategy tries, which candidate wins, the safety
 * limits for the device, and how the work is scheduled.
 */
import type {
  CandidateOutcome,
  CandidatePlan,
  FormatChoice,
  OptimizeSettings,
  OutputFormat,
  Selection,
  SkippedCandidate,
  SourceFormat,
  SourceInfo,
} from "./types";

export const OUTPUT_FORMATS: readonly OutputFormat[] = ["webp", "avif", "jpeg", "png"];
export const QUALITY_MIN = 30;
export const QUALITY_MAX = 100;
export const DIMENSION_MIN = 16;
export const DIMENSION_MAX = 16_000;

export const OUTPUT_MIME: Record<OutputFormat, string> = {
  webp: "image/webp",
  avif: "image/avif",
  jpeg: "image/jpeg",
  png: "image/png",
};
export const OUTPUT_EXTENSION: Record<OutputFormat, string> = { webp: ".webp", avif: ".avif", jpeg: ".jpg", png: ".png" };
export const FORMAT_LABEL: Record<OutputFormat, string> = { webp: "WebP", avif: "AVIF", jpeg: "JPEG", png: "PNG" };

/* --------------------------------- limits --------------------------------- */

export type EngineLimits = {
  /** Most pixels a source image may decode to. A decoded pixel takes four bytes of memory. */
  maxSourcePixels: number;
  /** Most pixels of an AVIF output. The AVIF encoder is WebAssembly on one thread: it is the slowest encoder and needs the most memory. */
  avifMaxPixels: number;
  /** Above this size, a multi-format comparison leaves AVIF out and says so. */
  avifCandidateMaxPixels: number;
  /** Most files in the queue at once. */
  maxFiles: number;
  /** Files processed at the same time. */
  concurrency: number;
  /** Most decoded pixels in work at the same time, across all running files. */
  pixelBudget: number;
};

export type DeviceHints = {
  /** `navigator.deviceMemory` in GB, where the browser reports it. */
  deviceMemory?: number | null;
  /** `navigator.hardwareConcurrency`. */
  cores?: number | null;
  /** True for phones and tablets. */
  mobile?: boolean;
};

const MP = 1_000_000;

/**
 * Safety limits for this device. They exist so that a file cannot exhaust the
 * tab's memory or keep it busy for minutes: there is no server behind the
 * tools, so these are the only limits there are.
 */
export function resolveEngineLimits(hints: DeviceHints = {}): EngineLimits {
  const memory = typeof hints.deviceMemory === "number" && hints.deviceMemory > 0 ? hints.deviceMemory : null;
  const cores = typeof hints.cores === "number" && hints.cores > 0 ? Math.floor(hints.cores) : 2;
  // Unknown memory is treated as a mid-range device: 4 GB on mobile, 8 GB elsewhere.
  const effectiveMemory = memory ?? (hints.mobile ? 4 : 8);
  const tier = effectiveMemory <= 2 ? "low" : effectiveMemory <= 4 ? "mid" : "high";
  const maxSourcePixels = tier === "low" ? 24 * MP : tier === "mid" ? 50 * MP : 100 * MP;
  return {
    maxSourcePixels,
    avifMaxPixels: tier === "low" ? 8 * MP : tier === "mid" ? 24 * MP : 40 * MP,
    avifCandidateMaxPixels: tier === "low" ? 4 * MP : tier === "mid" ? 12 * MP : 24 * MP,
    maxFiles: 300,
    // One core stays free for the page itself.
    concurrency: Math.max(1, Math.min(tier === "low" ? 1 : tier === "mid" ? 2 : 4, cores - 1)),
    pixelBudget: maxSourcePixels,
  };
}

/* ---------------------------------- sizes --------------------------------- */

export type TargetSize = { width: number; height: number; resized: boolean };

/**
 * The output size: the source fitted inside the maximum width and height,
 * keeping its proportions. An image is never enlarged.
 */
export function targetSize(width: number, height: number, maxWidth: number | null, maxHeight: number | null): TargetSize {
  const scale = Math.min(1, maxWidth ? maxWidth / width : 1, maxHeight ? maxHeight / height : 1);
  if (scale >= 1) return { width, height, resized: false };
  const scaledWidth = Math.max(1, Math.round(width * scale));
  const scaledHeight = Math.max(1, Math.round(height * scale));
  // Rounding must not push a side over its limit.
  return {
    width: maxWidth ? Math.min(scaledWidth, maxWidth) : scaledWidth,
    height: maxHeight ? Math.min(scaledHeight, maxHeight) : scaledHeight,
    resized: true,
  };
}

/** Largest side a format can store. Null when the format sets no practical limit. */
export function maxSideOf(format: OutputFormat): number | null {
  if (format === "webp") return 16_383;
  if (format === "jpeg") return 65_535;
  return null;
}

/* -------------------------------- candidates ------------------------------ */

const WRITABLE_SOURCE: Partial<Record<SourceFormat, OutputFormat>> = { jpeg: "jpeg", png: "png", webp: "webp", avif: "avif" };

/** The format that "keep format" means for a source, or null when the browser cannot write that format. */
export function sameFormatAs(source: SourceFormat): OutputFormat | null {
  return WRITABLE_SOURCE[source] ?? null;
}

export type CandidateSet =
  | { ok: true; candidates: CandidatePlan[]; skipped: SkippedCandidate[] }
  | { ok: false; message: string; hint: string };

function describe(format: OutputFormat, quality: number): string {
  return format === "png" ? "lossless PNG" : `${FORMAT_LABEL[format]} at quality ${quality}`;
}

/**
 * The encodes to attempt for one file.
 *
 * `single` yields exactly the chosen format. The other two strategies compare
 * WebP, AVIF and (for opaque images) JPEG at the chosen quality.
 */
export function planCandidates(
  settings: Pick<OptimizeSettings, "format" | "quality" | "strategy">,
  source: Pick<SourceInfo, "format">,
  output: { width: number; height: number },
  limits: Pick<EngineLimits, "avifMaxPixels" | "avifCandidateMaxPixels">,
): CandidateSet {
  const pixels = output.width * output.height;
  const megapixels = (value: number) => `${Math.round(value / MP)} MP`;
  const tooLongFor = (format: OutputFormat): string | null => {
    const side = maxSideOf(format);
    return side !== null && Math.max(output.width, output.height) > side
      ? `${FORMAT_LABEL[format]} cannot store a side longer than ${side.toLocaleString("en-US")} px`
      : null;
  };

  if (settings.strategy === "single") {
    const format = settings.format === "original" ? sameFormatAs(source.format) : settings.format;
    if (format === null) {
      return {
        ok: false,
        message: `A browser cannot write ${source.format.toUpperCase()} files, so this file cannot keep its format.`,
        hint: "Choose WebP, AVIF, JPEG or PNG as the output format.",
      };
    }
    const tooLong = tooLongFor(format);
    if (tooLong) return { ok: false, message: `${tooLong}. This output would be ${output.width} × ${output.height} px.`, hint: "Set a maximum width or height, or choose PNG or AVIF." };
    if (format === "avif" && pixels > limits.avifMaxPixels) {
      return {
        ok: false,
        message: `This would be a ${(pixels / MP).toFixed(1)} MP AVIF. On this device AVIF output is limited to ${megapixels(limits.avifMaxPixels)}, because the AVIF encoder runs in WebAssembly on one thread and a larger image could take minutes.`,
        hint: "Set a maximum width so the output is smaller, or choose WebP.",
      };
    }
    return { ok: true, candidates: [{ format, quality: settings.quality, note: describe(format, settings.quality), requiresOpaque: false }], skipped: [] };
  }

  const candidates: CandidatePlan[] = [];
  const skipped: SkippedCandidate[] = [];
  const consider = (format: OutputFormat, requiresOpaque: boolean, limitPixels?: number) => {
    const note = describe(format, settings.quality);
    const tooLong = tooLongFor(format);
    if (tooLong) skipped.push({ format, quality: settings.quality, note: `${note} — not tried: ${tooLong}` });
    else if (limitPixels !== undefined && pixels > limitPixels) skipped.push({ format, quality: settings.quality, note: `${note} — not tried: output above ${megapixels(limitPixels)}` });
    else candidates.push({ format, quality: settings.quality, note, requiresOpaque });
  };
  consider("webp", false);
  consider("avif", false, limits.avifCandidateMaxPixels);
  consider("jpeg", true);
  if (candidates.length === 0) {
    return { ok: false, message: `No output format can store ${output.width} × ${output.height} px.`, hint: "Set a maximum width or height." };
  }
  return { ok: true, candidates, skipped };
}

/* -------------------------------- selection ------------------------------- */

/**
 * Picks the file a job offers.
 *
 * The comparison uses the real byte counts of the encoded candidates. Under
 * `no-regression` the original file is the result whenever no candidate is
 * strictly smaller than it.
 */
export function selectOutcome(strategy: OptimizeSettings["strategy"], sourceBytes: number, candidates: readonly Pick<CandidateOutcome, "blob">[]): Selection | null {
  let best = -1;
  candidates.forEach((candidate, index) => {
    if (candidate.blob === null) return;
    if (best === -1 || candidate.blob.size < (candidates[best].blob as Blob).size) best = index;
  });
  if (strategy === "no-regression") {
    if (best === -1) return { chosen: "original", keptOriginal: true, keptReason: "No format could be encoded, so the original file is kept." };
    if ((candidates[best].blob as Blob).size >= sourceBytes) {
      return { chosen: "original", keptOriginal: true, keptReason: "Every result was at least as large as the original, so the original file is kept." };
    }
    return { chosen: best, keptOriginal: false, keptReason: null };
  }
  if (best === -1) return null;
  return { chosen: best, keptOriginal: false, keptReason: null };
}

/* --------------------------------- metrics -------------------------------- */

export type Savings = { savedBytes: number; savingsPercent: number; grew: boolean };

/** Bytes saved and the share of the original they are. Negative when the output is larger. */
export function savings(inputBytes: number, outputBytes: number): Savings {
  const savedBytes = inputBytes - outputBytes;
  const savingsPercent = inputBytes > 0 ? Math.round((savedBytes / inputBytes) * 1000) / 10 : 0;
  return { savedBytes, savingsPercent, grew: outputBytes > inputBytes };
}

/* --------------------------------- naming --------------------------------- */

/** A file name that is safe to save anywhere: no path, no control characters, at most 80 characters. */
export function sanitizeFilename(original: string): string {
  const base = (original || "image").split(/[\\/]/).pop() ?? "image";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, "_").replace(/\s+/g, "-").replace(/^\.+/, "").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "image";
}

/** `photo.jpg` → `photo-optimized.webp`. The suffix keeps the result from overwriting its source when both are saved in one folder. */
export function outputFilename(original: string, format: OutputFormat): string {
  const safe = sanitizeFilename(original);
  const dot = safe.lastIndexOf(".");
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  return `${base}-optimized${OUTPUT_EXTENSION[format]}`;
}

/* -------------------------------- scheduling ------------------------------ */

/**
 * How long one file may take before it is stopped. AVIF gets far more time
 * per pixel, because its encoder is the slowest by a wide margin.
 */
export function jobTimeoutMs(sourcePixels: number, outputPixels: number, formats: readonly OutputFormat[]): number {
  const megapixels = (value: number) => value / MP;
  let budget = 30_000 + megapixels(sourcePixels) * 1_500;
  for (const format of formats) budget += megapixels(outputPixels) * (format === "avif" ? 6_000 : 2_500);
  return Math.round(Math.min(budget, 15 * 60_000));
}

/**
 * Which waiting jobs may start now. A job starts when a worker is free and its
 * pixels fit in what is left of the pixel budget; a job larger than the whole
 * budget runs alone. Order is preserved, so no file is overtaken forever.
 */
export function nextToStart(waiting: readonly { id: string; pixels: number }[], running: readonly { pixels: number }[], limits: Pick<EngineLimits, "concurrency" | "pixelBudget">): string[] {
  const start: string[] = [];
  let slots = limits.concurrency - running.length;
  let used = running.reduce((sum, job) => sum + job.pixels, 0);
  for (const job of waiting) {
    if (slots <= 0) break;
    const alone = running.length + start.length === 0;
    if (!alone && used + job.pixels > limits.pixelBudget) break;
    start.push(job.id);
    used += job.pixels;
    slots -= 1;
  }
  return start;
}

/** The value a settings field takes after validation. */
export function clampQuality(value: number): number {
  return Number.isFinite(value) ? Math.min(QUALITY_MAX, Math.max(QUALITY_MIN, Math.round(value))) : 78;
}

/** Null for "no limit"; otherwise an integer inside the allowed range. */
export function clampDimension(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(DIMENSION_MAX, Math.max(DIMENSION_MIN, Math.round(value)));
}

export function isFormatChoice(value: unknown): value is FormatChoice {
  return value === "original" || (typeof value === "string" && (OUTPUT_FORMATS as readonly string[]).includes(value));
}
