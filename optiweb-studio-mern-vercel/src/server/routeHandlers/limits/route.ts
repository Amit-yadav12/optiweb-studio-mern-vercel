import { jsonOk, route } from "../../http/handler.js";
import { limits, imageFormats, fontDisplayValues } from "../../config/env.js";
import { supportsAvif } from "../../services/imageService.js";

/**
 * GET /api/v1/limits — the numbers the UI copy must match.
 * Public, no secrets. AVIF is offered only when the current libvips runtime
 * successfully encodes a tiny probe image.
 */
export const GET = route(async (_req, ctx) => {
  const avifSupported = await supportsAvif();
  return jsonOk(
    {
      maxFileBytes: limits.maxFileBytes,
      maxBatchBytes: limits.maxBatchBytes,
      maxFilesPerRequest: limits.maxFilesPerRequest,
      imageTimeoutMs: limits.imageTimeoutMs,
      imageConcurrency: limits.imageConcurrency,
      maxDecodedPixels: limits.maxDecodedPixels,
      maxCssChars: limits.maxCssChars,
      maxZipBytes: limits.maxZipBytes,
      artifactTtlHours: limits.artifactTtlHours,
      auditMaxResources: limits.auditMaxResources,
      auditMaxHtmlBytes: limits.auditMaxHtmlBytes,
      imageFormats: avifSupported ? imageFormats : imageFormats.filter((format) => format !== "avif"),
      avifSupported,
      fontDisplayValues,
    },
    ctx,
  );
});
