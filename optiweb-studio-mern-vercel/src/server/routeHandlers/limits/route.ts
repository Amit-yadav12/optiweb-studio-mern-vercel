import { jsonOk, route } from "../../http/handler.js";
import { limits, imageFormats, fontDisplayValues } from "../../config/env.js";
import { advancedCapacityView, imageCapacity } from "../../pipeline/views.js";
import { supportsAvif } from "../../services/imageService.js";

/**
 * GET /api/v1/limits — the numbers the UI copy must match.
 * Public, no secrets. AVIF is offered only when the current libvips runtime
 * successfully encodes a tiny probe image.
 */
export const GET = route(async (_req, ctx) => {
  // The database is only asked when object storage is configured. A first
  // connection can take a few seconds; a database that does not answer within
  // four must not hold up the page, so the request limits are reported then.
  // They are always valid, and the answer is reused for the next requests.
  const [avifSupported, image] = await Promise.all([supportsAvif(), imageCapacity({ maxWaitMs: 4000 })]);
  return jsonOk(
    {
      /**
       * The Image Optimizer's limits in the mode that is in effect: `direct`
       * (browser uploads to object storage, background job) or `request`
       * (files inside the request). The UI shows these numbers.
       */
      image,
      /** Whether the larger, not yet available capacity mode was requested, and why it is off. */
      advancedCapacity: advancedCapacityView(),
      /** Asset Analyzer: files per request. Their combined size is bounded by `maxBatchBytes`. */
      maxAssetFiles: limits.maxAssetFiles,
      // The fields below describe requests that carry files in their body.
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
      auditMaxResourceBytes: limits.auditMaxResourceBytes,
      auditMaxPages: limits.auditMaxPages,
      auditMaxTotalBytes: limits.auditMaxTotalBytes,
      imageFormats: avifSupported ? imageFormats : imageFormats.filter((format) => format !== "avif"),
      avifSupported,
      fontDisplayValues,
    },
    ctx,
  );
});
