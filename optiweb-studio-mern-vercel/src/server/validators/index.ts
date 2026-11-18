/** Server-side validators (zod). The same limits are surfaced in the UI copy. */
import { z } from "zod";
import {
  fontDisplayValues,
  imageFormats,
  limits,
} from "../config/env.js";

const qualitySchema = z
  .number()
  .int("Quality must be a whole number")
  .min(30, "Quality must be at least 30")
  .max(100, "Quality must be at most 100");

const dimensionSchema = z
  .number()
  .int("Dimensions must be whole numbers")
  .min(16, "Minimum dimension is 16px")
  .max(8000, "Maximum dimension is 8000px")
  .nullable();

export const imageSettingsSchema = z.object({
  format: z.enum(imageFormats).default("webp"),
  quality: qualitySchema.default(78),
  maxWidth: dimensionSchema.default(null),
  maxHeight: dimensionSchema.default(null),
  policy: z.enum(["single", "best-effort", "no-regression", "target-size"]).default("single"),
  targetBytes: z.number().int().min(256).max(10 * 1024 * 1024).nullable().default(null),
});

export const auditRequestSchema = z.object({
  url: z.string().min(8).max(2048),
  extraPages: z.number().int().min(0).max(3).default(0),
});

export type ImageSettingsInput = z.infer<typeof imageSettingsSchema>;

export const cssAnalyzeSchema = z.object({
  css: z
    .string()
    .min(1, "Paste some CSS to analyse")
    .max(limits.maxCssChars, `CSS must be shorter than ${limits.maxCssChars} characters`),
});

export const cssPatchSchema = cssAnalyzeSchema.extend({
  policy: z.enum(fontDisplayValues).default("swap"),
});

export const historyQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  kind: z.enum(["all", "image.optimize", "css.font-display", "asset.analyze", "site.audit"]).default("all"),
  status: z.enum(["all", "completed", "partial", "failed", "cancelled", "processing", "queued"]).default("all"),
  sort: z.enum(["newest", "oldest", "saved"]).default("newest"),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(5).max(50).default(10),
});

export const preferencesSchema = z.object({
  defaultImageFormat: z.enum(imageFormats).default("webp"),
  defaultQuality: qualitySchema.default(78),
  defaultMaxWidth: dimensionSchema.default(null),
  fontDisplayPolicy: z.enum(fontDisplayValues).default("swap"),
  analyzerThresholdKb: z.number().int().min(50).max(10_000).default(300),
  reduceMotion: z.boolean().default(false),
});

/** A new background image job: the files that will be uploaded, and how to convert them. */
export const createImageJobSchema = z.object({
  files: z
    .array(
      z.object({
        name: z.string().min(1, "Every file needs a name").max(255),
        type: z.string().max(120).default(""),
        size: z.number().int("File size must be a whole number of bytes").positive("A file cannot be empty"),
      }),
    )
    .min(1, "Add at least one file")
    // The real per-job limit is enforced with its own error; this only bounds the payload.
    .max(200),
  settings: imageSettingsSchema.optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/, "Use 8 to 80 letters, digits, dashes or underscores").optional(),
});

export const uploadRefSchema = z.object({ uploadId: z.string().uuid() });

export const artifactZipSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, "Select at least one result").max(50),
  name: z.string().trim().max(80).optional(),
});
