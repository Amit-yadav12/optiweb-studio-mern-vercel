import { jsonOk, route } from "@/server/http/handler";
import { limits, imageFormats, fontDisplayValues } from "@/server/config/env";


/**
 * GET /api/v1/limits — the numbers the UI copy must match.
 * Public, no secrets. Lets the client refuse an over-budget batch before upload.
 */
export const GET = route(async (_req, ctx) =>
  jsonOk(
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
      imageFormats,
      fontDisplayValues,
    },
    ctx,
  ),
);
