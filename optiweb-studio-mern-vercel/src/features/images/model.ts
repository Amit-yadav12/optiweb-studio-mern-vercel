/**
 * The Image Optimizer's state, and what is derived from it.
 *
 * Everything shown about a result is computed here from two measured things:
 * the size of the file the user selected (`File.size`) and the size of the
 * file the browser encoded (`Blob.size`). Nothing is estimated.
 */
import { FORMAT_LABEL, outputFilename, sanitizeFilename, savings } from "./engine/plan";
import type { JobResult, OptimizeSettings, OutputFormat, Selection, SkippedCandidate, SourceInfo } from "./engine/types";

export type ItemStatus = "checking" | "ready" | "rejected" | "queued" | "processing" | "done" | "failed" | "cancelled";

export type ItemProblem = { message: string; hint: string };

export type ItemOutcome = {
  result: JobResult;
  /** Candidates that were planned out before the job ran, with the reason. */
  skipped: SkippedCandidate[];
  selection: Selection;
  /** Set by the user: keep the original file instead of a result that is larger. */
  preferOriginal: boolean;
  /** Wall-clock time of the job, from start to result. */
  durationMs: number;
  /** The settings this result was produced with. */
  settingsKey: string;
};

export type OptimizerItem = {
  id: string;
  file: File;
  status: ItemStatus;
  /** Header facts. Null until the file has been checked, and for a refused file. */
  source: SourceInfo | null;
  problem: ItemProblem | null;
  /** What the engine is doing with the file right now, in words. */
  stage: string | null;
  outcome: ItemOutcome | null;
};

/** The file a finished item offers for download. */
export type FinalFile = {
  blob: Blob;
  filename: string;
  /** "WebP", "AVIF", … or the source format's name when the original is kept. */
  formatLabel: string;
  format: OutputFormat | null;
  bytes: number;
  width: number;
  height: number;
  /** True when the offered file is the original, byte for byte. */
  isOriginal: boolean;
  /** Why the original is offered. Null when a converted file is offered. */
  originalReason: string | null;
  savedBytes: number;
  savingsPercent: number;
  /** True when the offered file is larger than the original. */
  grew: boolean;
  /** How the bytes were produced. Null for the original. */
  encoder: "browser" | "wasm" | null;
};

/** One string per distinct combination of settings, so a result can tell whether it is current. */
export function settingsKey(settings: OptimizeSettings): string {
  const multi = settings.strategy !== "single";
  return [settings.strategy, multi ? "*" : settings.format, settings.quality, settings.maxWidth ?? "-", settings.maxHeight ?? "-"].join("|");
}

/** The converted candidate the strategy chose, whether or not the user then preferred the original. Null when the strategy itself kept the original. */
export function chosenCandidate(outcome: ItemOutcome) {
  return outcome.selection.chosen === "original" ? null : outcome.result.candidates[outcome.selection.chosen];
}

export function finalOf(item: OptimizerItem): FinalFile | null {
  const { outcome, source } = item;
  if (item.status !== "done" || !outcome || !source) return null;
  const candidate = chosenCandidate(outcome);
  if (candidate === null || candidate.blob === null || outcome.preferOriginal) {
    return {
      blob: item.file,
      filename: sanitizeFilename(item.file.name),
      formatLabel: source.format.toUpperCase(),
      format: null,
      bytes: item.file.size,
      width: source.width,
      height: source.height,
      isOriginal: true,
      originalReason: outcome.preferOriginal ? "You chose to keep the original for this file." : (outcome.selection.keptReason ?? "The original file is kept."),
      savedBytes: 0,
      savingsPercent: 0,
      grew: false,
      encoder: null,
    };
  }
  const delta = savings(item.file.size, candidate.blob.size);
  return {
    blob: candidate.blob,
    filename: outputFilename(item.file.name, candidate.format),
    formatLabel: FORMAT_LABEL[candidate.format],
    format: candidate.format,
    bytes: candidate.blob.size,
    width: outcome.result.outputWidth,
    height: outcome.result.outputHeight,
    isOriginal: false,
    originalReason: null,
    savedBytes: delta.savedBytes,
    savingsPercent: delta.savingsPercent,
    grew: delta.grew,
    encoder: candidate.encoder,
  };
}

/**
 * True when the strategy produced a converted file that is not smaller than
 * the original. The interface then offers the original instead.
 */
export function convertedIsNotSmaller(item: OptimizerItem): boolean {
  if (!item.outcome) return false;
  const candidate = chosenCandidate(item.outcome);
  return candidate !== null && candidate.blob !== null && candidate.blob.size >= item.file.size;
}

export type BatchSummary = {
  /** Files with a result (converted or original kept). */
  done: number;
  converted: number;
  keptOriginal: number;
  failed: number;
  rejected: number;
  cancelled: number;
  /** Bytes of the files that have a result, before and after. */
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  savingsPercent: number;
  /** Results that are larger than their original. */
  grew: number;
};

export function summarize(items: readonly OptimizerItem[]): BatchSummary {
  const summary: BatchSummary = { done: 0, converted: 0, keptOriginal: 0, failed: 0, rejected: 0, cancelled: 0, inputBytes: 0, outputBytes: 0, savedBytes: 0, savingsPercent: 0, grew: 0 };
  for (const item of items) {
    if (item.status === "failed") summary.failed += 1;
    else if (item.status === "rejected") summary.rejected += 1;
    else if (item.status === "cancelled") summary.cancelled += 1;
    const final = finalOf(item);
    if (!final) continue;
    summary.done += 1;
    if (final.isOriginal) summary.keptOriginal += 1;
    else summary.converted += 1;
    if (final.grew) summary.grew += 1;
    summary.inputBytes += item.file.size;
    summary.outputBytes += final.bytes;
  }
  const delta = savings(summary.inputBytes, summary.outputBytes);
  summary.savedBytes = delta.savedBytes;
  summary.savingsPercent = delta.savingsPercent;
  return summary;
}

/** Short label and tone for a status chip. */
export const STATUS_LABEL: Record<ItemStatus, { label: string; tone: "neutral" | "accent" | "ok" | "warn" | "danger" }> = {
  checking: { label: "checking", tone: "neutral" },
  ready: { label: "ready", tone: "neutral" },
  rejected: { label: "not accepted", tone: "danger" },
  queued: { label: "waiting", tone: "neutral" },
  processing: { label: "processing", tone: "accent" },
  done: { label: "done", tone: "ok" },
  failed: { label: "failed", tone: "danger" },
  cancelled: { label: "cancelled", tone: "warn" },
};

/** True for a file that the next run will process with these settings. */
export function isPending(item: OptimizerItem, key: string): boolean {
  if (item.status === "ready" || item.status === "failed" || item.status === "cancelled") return item.source !== null;
  return item.status === "done" && item.outcome?.settingsKey !== key;
}
