import sharp from "sharp";
import path from "node:path";
import { limits, imageFormats, type ImageFormat } from "@/server/config/env";
import {
  badRequest,
  payloadTooLarge,
  unprocessable,
  unsupportedMedia,
} from "@/server/http/errors";
import type { CandidateRecord, ImageMetrics, ImageOptimizeSettings } from "@/types/domain";
import type { OptimizationPolicy } from "@/server/config/env";

sharp.cache(false);
sharp.concurrency(1);

const MIME_BY_FORMAT: Record<Exclude<ImageFormat, "original">, string> = {
  webp: "image/webp",
  avif: "image/avif",
  jpeg: "image/jpeg",
  png: "image/png",
};

const EXT_BY_FORMAT: Record<Exclude<ImageFormat, "original">, string> = {
  webp: ".webp",
  avif: ".avif",
  jpeg: ".jpg",
  png: ".png",
};

const RASTER_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/tiff",
]);

export type Sniffed = {
  format: string;
  width: number | null;
  height: number | null;
  isRaster: boolean;
  isSvg: boolean;
  /** Number of frames/pages. > 1 means the source is animated. */
  pages: number;
  isAnimated: boolean;
  hasAlpha: boolean;
};

/**
 * Verifies the actual bytes with libpng/libjpeg-style sniffing via sharp. The
 * declared Content-Type of an upload is never trusted.
 */
export async function sniffImage(input: Buffer): Promise<Sniffed> {
  if (!input || input.byteLength === 0) {
    throw badRequest("The uploaded file is empty.", "Re-export the image and try again.");
  }
  try {
    // `animated: true` makes libvips report every frame of an animated source
    // instead of only the first, so animation can never be lost silently.
    const metadata = await sharp(input, {
      failOn: "error",
      animated: true,
      // Decoder-level cap: libvips refuses to allocate a raster larger than this.
      limitInputPixels: limits.maxDecodedPixels,
    }).metadata();
    const format = (metadata.format ?? "unknown").toLowerCase();
    const pages = metadata.pages ?? 1;
    // libvips commonly reports AVIF containers as HEIF. Normalize that alias
    // for the raster allowlist while preserving the decoder's original label
    // for diagnostics and downstream output-format selection.
    const rasterMimeFormat = format === "jpg" ? "jpeg" : format === "heif" || format === "heif-sequence" ? "avif" : format;
    return {
      format,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      isRaster: RASTER_MIME.has(`image/${rasterMimeFormat}`),
      isSvg: format === "svg" || format === "svgz",
      pages,
      isAnimated: pages > 1,
      hasAlpha: Boolean(metadata.hasAlpha),
    };
  } catch (error) {
    throw unsupportedMedia(
      "This file is not a readable image.",
      error instanceof Error ? "The decoder rejected the file contents." : undefined,
    );
  }
}

export function sanitizeFilename(original: string): string {
  const base = path.basename(original || "image").replace(/[^\w.\- ]+/g, "_");
  const trimmed = base.replace(/\s+/g, "-").slice(0, 80);
  return trimmed.length > 0 ? trimmed : "image";
}

export function outputFilename(original: string, format: ImageFormat): string {
  const base = sanitizeFilename(original).replace(/\.[^.]+$/, "");
  const effective: ImageFormat = format;
  const ext = effective === "original" ? (path.extname(sanitizeFilename(original)) || ".png") : EXT_BY_FORMAT[effective];
  return `${base}-optiweb${ext}`;
}

export function contentTypeForFilename(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".css":
      return "text/css; charset=utf-8";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

export function assertUploadSize(byteLength: number, filename: string): void {
  if (byteLength > limits.maxFileBytes) {
    throw payloadTooLarge(
      `"${sanitizeFilename(filename)}" is ${(byteLength / (1024 * 1024)).toFixed(1)} MB, above the ${(limits.maxFileBytes / (1024 * 1024)).toFixed(0)} MB limit.`,
      "Downscale the image locally, then upload again.",
    );
  }
}

/**
 * libvips reports AVIF as "heif". The UI should say AVIF, so the reported
 * format is normalised against the format that was actually requested.
 */
export function normalizeFormatName(reported: string, target: Exclude<ImageFormat, "original">): string {
  if (target === "avif" && (reported === "heif" || reported === "heif-sequence")) return "avif";
  return reported;
}

export function resolveOutputFormat(requested: ImageFormat, sourceFormat: string): Exclude<ImageFormat, "original"> {
  if (requested !== "original") return requested;
  const normalized = sourceFormat === "jpg" ? "jpeg" : sourceFormat;
  const allowed = imageFormats.filter((f) => f !== "original") as Array<Exclude<ImageFormat, "original">>;
  const match = allowed.find((f) => f === normalized);
  return match ?? "png";
}

export type OptimizeOutcome = {
  metrics: ImageMetrics;
  output: Buffer;
  contentType: string;
  filename: string;
  candidates: CandidateRecord[];
  retainedOriginal: boolean;
  targetMet: boolean | null;
};

/**
 * Runs one real transform. Output bytes, dimensions and the derived savings are
 * all measured from the produced buffer — never estimated.
 */
export async function optimizeImage(params: {
  filename: string;
  buffer: Buffer;
  settings: ImageOptimizeSettings;
}): Promise<OptimizeOutcome> {
  const { buffer, settings } = params;
  const filename = sanitizeFilename(params.filename);
  assertUploadSize(buffer.byteLength, filename);

  const sniffed = await sniffImage(buffer);
  const decodedPixels = (sniffed.width ?? 0) * (sniffed.height ?? 0) * Math.max(1, sniffed.pages);
  if (decodedPixels > limits.maxDecodedPixels) {
    throw payloadTooLarge(
      `"${filename}" decodes to ${decodedPixels.toLocaleString()} pixels, above the ${limits.maxDecodedPixels.toLocaleString()} pixel limit.`,
      "Downscale the image locally, then upload again. This cap exists so a small compressed file cannot expand into gigabytes of RAM.",
    );
  }
  if (sniffed.isSvg) {
    throw unsupportedMedia(
      `"${filename}" is an SVG (vector). Re-encoding it to a raster format would usually add weight.`,
      "Serve the SVG directly, or upload a raster image to optimize.",
    );
  }
  if (!sniffed.isRaster) {
    throw unsupportedMedia(`"${filename}" is a ${sniffed.format} file, which this pipeline cannot re-encode.`);
  }

  const inputBytes = buffer.byteLength;
  const targetFormat = resolveOutputFormat(settings.format, sniffed.format);

  // An animated source must never be flattened into a single frame while the
  // savings figure still counts the whole animated file. WebP is the only
  // offered target that can carry the animation.
  if (sniffed.isAnimated && targetFormat !== "webp") {
    throw unsupportedMedia(
      `"${filename}" is an animated ${sniffed.format.toUpperCase()} (${sniffed.pages} frames) and cannot be written as ${targetFormat.toUpperCase()} without dropping frames.`,
      "Convert it to WebP to keep the animation, or export a single frame first.",
    );
  }

  let pipeline = sharp(buffer, {
    failOn: "error",
    animated: sniffed.isAnimated,
    limitInputPixels: limits.maxDecodedPixels,
  }).rotate();
  // sharp's own timeout actually stops the worker; the JS timer below is a backstop
  // that also destroys the pipeline so a hung encode cannot keep a CPU core.
  pipeline = pipeline.timeout({ seconds: Math.max(1, Math.ceil(limits.imageTimeoutMs / 1000)) });
  const needsResize =
    (settings.maxWidth !== null && (sniffed.width ?? Infinity) > settings.maxWidth) ||
    (settings.maxHeight !== null && (sniffed.height ?? Infinity) > settings.maxHeight);

  if (needsResize) {
    pipeline = pipeline.resize({
      width: settings.maxWidth ?? undefined,
      height: settings.maxHeight ?? undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  switch (targetFormat) {
    case "webp":
      pipeline = pipeline.webp({ quality: settings.quality, effort: 4 });
      break;
    case "avif":
      pipeline = pipeline.avif({ quality: settings.quality, effort: 3 });
      break;
    case "jpeg":
      pipeline = pipeline.jpeg({ quality: settings.quality, mozjpeg: true });
      break;
    case "png":
      pipeline = pipeline.png({ compressionLevel: 9 });
      break;
  }

  let output: Buffer;
  try {
    output = await withTimeout(pipeline.toBuffer({ resolveWithObject: false }), limits.imageTimeoutMs, () => {
      try {
        pipeline.destroy();
      } catch {
        /* already finished or destroyed */
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/timeout|timed out/i.test(message)) {
      throw unprocessable(
        `"${filename}" took too long to process and was stopped.`,
        "Try a smaller source image or a lower quality setting.",
      );
    }
    throw unprocessable(`"${filename}" could not be re-encoded by the image pipeline.`);
  }

  const metadata = await sharp(output, { animated: sniffed.isAnimated }).metadata();
  const outputBytes = output.byteLength;
  const savedBytes = inputBytes - outputBytes;
  const savingsPercent = inputBytes > 0 ? (savedBytes / inputBytes) * 100 : 0;

  const metrics: ImageMetrics = {
    inputBytes,
    outputBytes,
    savedBytes,
    savingsPercent: Math.round(savingsPercent * 100) / 100,
    inputWidth: sniffed.width,
    inputHeight: sniffed.height,
    outputWidth: metadata.width ?? null,
    outputHeight: metadata.height ?? null,
    outputFormat: normalizeFormatName(metadata.format ?? targetFormat, targetFormat),
  };

  return {
    metrics,
    output,
    contentType: MIME_BY_FORMAT[targetFormat],
    filename: outputFilename(filename, settings.format),
    candidates: [
      {
        format: metrics.outputFormat,
        quality: settings.quality,
        bytes: outputBytes,
        selected: true,
        note: "single-format encode",
      },
    ],
    retainedOriginal: false,
    targetMet: null,
  };
}

/**
 * Evaluates a bounded set of real encodes and picks according to `policy`.
 * Original bytes are always a candidate so no-regression can keep them.
 */
export async function optimizeWithPolicy(params: {
  filename: string;
  buffer: Buffer;
  settings: ImageOptimizeSettings;
}): Promise<OptimizeOutcome> {
  const policy: OptimizationPolicy = params.settings.policy ?? "single";
  if (policy === "single") {
    return optimizeImage(params);
  }

  const filename = sanitizeFilename(params.filename);
  assertUploadSize(params.buffer.byteLength, filename);
  const sniffed = await sniffImage(params.buffer);
  if (sniffed.isSvg || !sniffed.isRaster) {
    return optimizeImage(params);
  }

  const inputBytes = params.buffer.byteLength;
  const plans: Array<{ format: Exclude<ImageFormat, "original">; quality: number; note: string }> = [];

  if (sniffed.isAnimated) {
    plans.push({ format: "webp", quality: params.settings.quality, note: "animated → WebP only" });
  } else {
    plans.push({ format: "webp", quality: params.settings.quality, note: "lossy WebP" });
    plans.push({ format: "avif", quality: params.settings.quality, note: "lossy AVIF" });
    if (!sniffed.hasAlpha) {
      plans.push({ format: "jpeg", quality: params.settings.quality, note: "mozjpeg" });
    }
    if (policy === "target-size" && params.settings.targetBytes) {
      for (const q of [60, 45, 30]) {
        if (q < params.settings.quality) {
          plans.push({ format: "webp", quality: q, note: `target-size WebP q=${q}` });
        }
      }
    }
  }

  const unique = plans.filter(
    (plan, index) => plans.findIndex((p) => p.format === plan.format && p.quality === plan.quality) === index,
  ).slice(0, 5);

  const candidates: CandidateRecord[] = [
    { format: "original", quality: 100, bytes: inputBytes, selected: false, note: "source file" },
  ];
  let best: OptimizeOutcome | null = null;

  for (const plan of unique) {
    try {
      const encoded = await optimizeImage({
        filename,
        buffer: params.buffer,
        settings: { ...params.settings, format: plan.format, quality: plan.quality, policy: "single" },
      });
      candidates.push({
        format: encoded.metrics.outputFormat,
        quality: plan.quality,
        bytes: encoded.metrics.outputBytes,
        selected: false,
        note: plan.note,
      });
      if (!best || encoded.metrics.outputBytes < best.metrics.outputBytes) {
        best = encoded;
      }
    } catch {
      candidates.push({
        format: plan.format,
        quality: plan.quality,
        bytes: Number.POSITIVE_INFINITY,
        selected: false,
        note: `${plan.note} — encode failed`,
      });
    }
  }

  const target = params.settings.targetBytes ?? null;
  const keepOriginal =
    policy === "no-regression" && (best === null || best.metrics.outputBytes >= inputBytes);

  if (keepOriginal || best === null) {
    candidates[0].selected = true;
    const metrics: ImageMetrics = {
      inputBytes,
      outputBytes: inputBytes,
      savedBytes: 0,
      savingsPercent: 0,
      inputWidth: sniffed.width,
      inputHeight: sniffed.height,
      outputWidth: sniffed.width,
      outputHeight: sniffed.height,
      outputFormat: sniffed.format,
    };
    return {
      metrics,
      output: params.buffer,
      contentType: `image/${sniffed.format === "jpg" ? "jpeg" : sniffed.format}`,
      filename: sanitizeFilename(params.filename),
      candidates: candidates.map((c) => ({ ...c, bytes: Number.isFinite(c.bytes) ? c.bytes : 0 })),
      retainedOriginal: true,
      targetMet: target !== null ? inputBytes <= target : null,
    };
  }

  const selectedKey = `${best.metrics.outputFormat}:${best.metrics.outputBytes}`;
  const marked = candidates.map((c) => ({
    ...c,
    bytes: Number.isFinite(c.bytes) ? c.bytes : 0,
    selected: `${c.format}:${c.bytes}` === selectedKey || (c.format === best!.metrics.outputFormat && c.bytes === best!.metrics.outputBytes && c.note !== "source file"),
  }));
  // Ensure exactly one selected among generated, not original.
  let picked = false;
  const normalised = marked.map((c) => {
    if (c.note === "source file") return { ...c, selected: false };
    if (!picked && c.bytes === best!.metrics.outputBytes && c.format === best!.metrics.outputFormat) {
      picked = true;
      return { ...c, selected: true };
    }
    return { ...c, selected: false };
  });

  return {
    ...best,
    candidates: normalised,
    retainedOriginal: false,
    targetMet: target !== null ? best.metrics.outputBytes <= target : null,
  };
}

/** Wall-clock guard for a single transform (sharp also gets its own timeout). */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* ignore destroy races */
      }
      reject(new Error(`image transform timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("image transform failed"));
      },
    );
  });
}

/** Bounded-concurrency map so a batch cannot saturate the CPU. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}
