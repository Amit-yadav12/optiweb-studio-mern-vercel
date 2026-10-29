/** Image optimization controller: validate → transform → measure → persist. */
import { limits } from "@/server/config/env";
import { jsonOk, type RouteContext } from "@/server/http/handler";
import { readMultipart } from "@/server/http/multipart";
import { ApiError, payloadTooLarge } from "@/server/http/errors";
import { imageSettingsSchema } from "@/server/validators";
import {
  mapWithConcurrency,
  optimizeWithPolicy,
  sanitizeFilename,
} from "@/server/services/imageService";
import { persistJob } from "@/server/services/storageService";
import type { ImageOptimizeResponse, ImageResult } from "@/types/domain";

type Processed = { result: ImageResult; output: Buffer | null };

function numberField(fields: Record<string, string>, key: string): number | null {
  const raw = fields[key];
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The MIME type of the produced bytes — derived from the format that was
 * actually encoded, never from the name of the upload.
 */
function producedContentType(result: ImageResult): string {
  switch (result.outputFormat) {
    case "webp":
      return "image/webp";
    case "avif":
    case "heif":
      return "image/avif";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "tiff":
      return "image/tiff";
    default:
      return "application/octet-stream";
  }
}

/** One transform per file. Metrics come from the produced buffer, never twice-run. */
async function processOne(
  file: { filename: string; contentType: string; buffer: Buffer },
  settings: ReturnType<typeof imageSettingsSchema.parse>,
): Promise<Processed> {
  const startedAt = Date.now();
  try {
    const outcome = await optimizeWithPolicy({
        filename: file.filename,
        buffer: file.buffer,
        settings,
      });
      return {
        result: {
          id: crypto.randomUUID(),
          filename: sanitizeFilename(file.filename),
          outputFilename: outcome.filename,
          status: "completed",
          inputContentType: file.contentType,
          durationMs: Date.now() - startedAt,
          ...outcome.metrics,
          candidates: outcome.candidates,
          retainedOriginal: outcome.retainedOriginal,
          targetBytes: settings.targetBytes ?? null,
          targetMet: outcome.targetMet,
          policy: settings.policy ?? "single",
        },
        output: outcome.output,
      };
  } catch (error) {
    // Per-file failures never abort the batch; the job status reports partial.
    const apiError = error instanceof ApiError ? error : null;
    return {
      result: {
        id: crypto.randomUUID(),
        filename: sanitizeFilename(file.filename),
        outputFilename: sanitizeFilename(file.filename),
        status: "failed",
        inputContentType: file.contentType,
        durationMs: Date.now() - startedAt,
        inputBytes: file.buffer.byteLength,
        outputBytes: 0,
        savedBytes: 0,
        savingsPercent: 0,
        inputWidth: null,
        inputHeight: null,
        outputWidth: null,
        outputHeight: null,
        outputFormat: "—",
        errorCode: apiError?.code ?? "processing_failed",
        message:
          apiError?.message ?? "The image could not be processed. It may be corrupt or an unsupported variant.",
      },
      output: null,
    };
  }
}

export async function optimizeUploadedImages(req: Request, ctx: RouteContext): Promise<Response> {
  const { files, fields } = await readMultipart(req, { kind: "image" });

  const settings = imageSettingsSchema.parse({
    format: fields.format ?? "webp",
    quality: numberField(fields, "quality") ?? 78,
    maxWidth: numberField(fields, "maxWidth"),
    maxHeight: numberField(fields, "maxHeight"),
    policy: fields.policy ?? "single",
    targetBytes: numberField(fields, "targetBytes"),
  });

  const processed = await mapWithConcurrency(files, limits.imageConcurrency, (file) =>
    processOne(file, settings),
  );

  const totals = processed.reduce(
    (acc, { result }) => {
      if (result.status !== "completed") return acc;
      acc.inputBytes += result.inputBytes;
      acc.outputBytes += result.outputBytes;
      acc.savedBytes += result.savedBytes;
      return acc;
    },
    { inputBytes: 0, outputBytes: 0, savedBytes: 0 },
  );

  const completed = processed.filter((entry) => entry.result.status === "completed").length;
  const failed = processed.length - completed;
  const status: ImageOptimizeResponse["status"] =
    completed === 0 ? "failed" : failed > 0 ? "partial" : "completed";
  const savingsPercent =
    totals.inputBytes > 0 ? Math.round((totals.savedBytes / totals.inputBytes) * 10000) / 100 : 0;

  const stored = await persistJob({
    sessionId: ctx.sessionId,
    kind: "image.optimize",
    status,
    label: `${completed} image${completed === 1 ? "" : "s"} → ${settings.format.toUpperCase()}`,
    fileCount: processed.length,
    inputBytes: totals.inputBytes,
    outputBytes: totals.outputBytes,
    savedBytes: totals.savedBytes,
    note:
      settings.maxWidth || settings.maxHeight
        ? `quality ${settings.quality} · max ${settings.maxWidth ?? "auto"}×${settings.maxHeight ?? "auto"}`
        : `quality ${settings.quality}`,
    items: processed.map(({ result, output }) => ({
      filename: result.filename,
      status: result.status,
      inputBytes: result.inputBytes,
      outputBytes: result.outputBytes,
      savedBytes: result.savedBytes,
      savingsPercent: result.savingsPercent,
      inputWidth: result.inputWidth,
      inputHeight: result.inputHeight,
      outputWidth: result.outputWidth,
      outputHeight: result.outputHeight,
      outputFormat: result.outputFormat,
      message: result.message,
      artifact:
        output && result.status === "completed"
          ? {
              filename: result.outputFilename,
              contentType: producedContentType(result),
              data: output,
              kind: "image",
            }
          : null,
    })),
  });

  // When persistence succeeds, replace placeholder ids with the stored artifact
  // ids so `/api/v1/artifacts/:id` can stream the bytes back later.
  const artifactIds = Array.from(stored.artifacts.keys());
  let cursor = 0;
  const results = processed.map(({ result }) => {
    if (result.status !== "completed" || !stored.persisted) return result;
    const id = artifactIds[cursor];
    cursor += 1;
    return id ? { ...result, id } : result;
  });

  const body: ImageOptimizeResponse = {
    jobId: stored.jobId ?? "",
    status,
    results,
    persisted: stored.persisted,
    totals: { ...totals, savingsPercent },
  };

  return jsonOk(body, ctx);
}
