import { jsonOk, parseJson, route } from "../../http/handler.js";
import { getPreferences, savePreferences } from "../../services/storageService.js";
import { preferencesSchema } from "../../validators/index.js";
import { limits } from "../../config/env.js";
import type { Preferences } from "../../../types/domain.js";


const FALLBACK: Preferences = {
  defaultImageFormat: "webp",
  defaultQuality: 78,
  defaultMaxWidth: null,
  fontDisplayPolicy: "swap",
  analyzerThresholdKb: 300,
  reduceMotion: false,
  updatedAt: null,
};

/** GET /api/v1/preferences — session-scoped defaults. */
export const GET = route(async (_req, ctx) => {
  const stored = await getPreferences(ctx.sessionId);
  return jsonOk(stored ?? FALLBACK, ctx);
}, { bucket: "preferences" });

/** PUT /api/v1/preferences */
export const PUT = route(async (req, ctx) => {
  const input = await parseJson(req, preferencesSchema) as Preferences;
  const saved = await savePreferences(ctx.sessionId, {
    ...input,
    updatedAt: new Date().toISOString(),
  });
  return jsonOk(saved, ctx);
}, { bucket: "preferences" });

/** GET-adjacent metadata used by the Settings screen copy. */
export const OPTIONS = route(async (_req, ctx) =>
  jsonOk(
    {
      maxFileMb: Math.round(limits.maxFileBytes / (1024 * 1024)),
      maxFiles: limits.maxFilesPerRequest,
      artifactTtlHours: limits.artifactTtlHours,
    },
    ctx,
  ),
);
