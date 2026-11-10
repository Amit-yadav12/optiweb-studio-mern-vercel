/**
 * What an image optimization response means for the person looking at it.
 *
 * A response answers two separate questions: were the files converted
 * (`status`), and were the results stored (`persisted`). This module turns the
 * two answers into one of three outcomes, so every part of the screen (banner,
 * badges, toast, download links) is driven by the same decision.
 *
 * It is pure and has no React or browser dependency, so it can be tested
 * directly.
 */
import type { Tone } from "@/lib/status";
import type { ImageOptimizeResponse, ImageResult, StorageFailureCategory } from "@/types/domain";

export type ImageOutcomeKind =
  /** At least one file was converted, and the job and its output files are stored. */
  | "stored"
  /** At least one file was converted, but nothing was stored: no downloads and no history entry. */
  | "converted_not_stored"
  /** No file was converted. */
  | "conversion_failed";

export type ImageOutcome = {
  kind: ImageOutcomeKind;
  tone: Extract<Tone, "ok" | "warn" | "danger">;
  title: string;
  message: string;
  /** Why storage failed, what to do about it, and the failure category. Set only when nothing was stored. */
  storageFailure: { message: string; hint: string | null; category: StorageFailureCategory | null } | null;
  /** Badge for the conversion result. */
  conversion: { tone: Tone; label: string };
  /** Badge for the storage result. */
  storage: { tone: Tone; label: string };
  /** True only when output files are stored. Downloads, previews of the output and history links depend on it. */
  downloadsAvailable: boolean;
  /** History ID of the stored job, or null when there is no history entry. */
  historyJobId: string | null;
  toast: { tone: Tone; title: string; description: string | null };
  counts: { submitted: number; converted: number; failed: number };
};

const files = (count: number): string => `${count} file${count === 1 ? "" : "s"}`;

/** Wording used when a response says nothing was stored but gives no reason. */
const UNKNOWN_STORAGE_FAILURE = "Storage is unavailable.";

export function describeImageOutcome(response: ImageOptimizeResponse): ImageOutcome {
  const submitted = response.results.length;
  const converted = response.results.filter((result) => result.status === "completed").length;
  const failed = submitted - converted;
  const counts = { submitted, converted, failed };

  // Both fields come from the same server value. Treat the result as stored
  // only when neither of them says otherwise.
  const stored = response.persisted === true && response.storage?.persisted !== false;
  const reported = response.storage && response.storage.persisted === false ? response.storage : null;
  const storageFailure = stored
    ? null
    : { message: reported?.message ?? UNKNOWN_STORAGE_FAILURE, hint: reported?.hint ?? null, category: reported?.category ?? null };

  const conversion: ImageOutcome["conversion"] =
    converted === 0
      ? { tone: "danger", label: "Conversion failed" }
      : failed > 0
        ? { tone: "warn", label: "Partly converted" }
        : { tone: "ok", label: "Converted" };
  const storage: ImageOutcome["storage"] = stored ? { tone: "ok", label: "Stored" } : { tone: "warn", label: "Not stored" };
  const shared = { storageFailure, conversion, storage, counts };

  if (converted === 0) {
    return {
      ...shared,
      kind: "conversion_failed",
      tone: "danger",
      title: "Conversion failed",
      message:
        submitted === 1
          ? "The file could not be converted. No output was produced, so there is nothing to download."
          : `None of the ${submitted} files could be converted. No output was produced, so there is nothing to download.`,
      downloadsAvailable: false,
      historyJobId: stored && response.jobId ? response.jobId : null,
      toast: { tone: "danger", title: "No file could be converted", description: "The reason for each file is listed under Rejected files." },
    };
  }

  const rejected = failed > 0 ? ` ${files(failed)} could not be converted; the reasons are listed under Rejected files.` : "";

  if (!stored) {
    return {
      ...shared,
      kind: "converted_not_stored",
      tone: "warn",
      title: "Converted, but not stored",
      message: `${files(converted)} ${converted === 1 ? "was" : "were"} converted, but the output could not be stored. ${converted === 1 ? "It" : "They"} cannot be downloaded, and this run is not in History.${rejected}`,
      downloadsAvailable: false,
      historyJobId: null,
      toast: {
        tone: "warn",
        title: "Converted, but not stored",
        description: `Nothing can be downloaded for this run. ${storageFailure?.message ?? UNKNOWN_STORAGE_FAILURE}`,
      },
    };
  }

  return {
    ...shared,
    kind: "stored",
    tone: failed > 0 ? "warn" : "ok",
    title: failed > 0 ? `${converted} of ${submitted} files converted and stored` : "Converted and stored",
    message:
      failed > 0
        ? `The converted files are stored and can be downloaded below. The job is in History.${rejected}`
        : converted === 1
          ? "The file was converted and stored. You can download it below, and the job is in History."
          : `All ${converted} files were converted and stored. You can download them below, and the job is in History.`,
    downloadsAvailable: true,
    historyJobId: response.jobId || null,
    toast: {
      tone: failed > 0 ? "warn" : "ok",
      title: failed > 0 ? `${converted} of ${submitted} files converted and stored` : `${files(converted)} converted and stored`,
      description: null,
    },
  };
}

/**
 * The ID under which a result's output file can be downloaded, or null.
 *
 * Every download link, preview and ZIP request goes through this function. It
 * returns an ID only when the response says the job was stored and the server
 * named a stored file for this result, so a link is never built for output
 * that does not exist.
 */
export function storedArtifactId(response: ImageOptimizeResponse, result: ImageResult): string | null {
  const stored = response.persisted === true && response.storage?.persisted !== false;
  if (!stored || result.status !== "completed") return null;
  return typeof result.artifactId === "string" && result.artifactId.length > 0 ? result.artifactId : null;
}

/** The part of a queued upload that its result decides. */
export type SettledResult = {
  status: "completed" | "failed";
  result: ImageResult;
  /** ID of the stored output file, or null when the output was not stored. */
  artifactId: string | null;
  error: string | undefined;
};

/**
 * What a queued upload becomes when its result arrives.
 *
 * `artifactId` is decided here, from the response of the run that produced the
 * result, and kept with the upload. A later run in the same queue therefore
 * cannot change whether an earlier result has a download.
 */
export function settleResult(response: ImageOptimizeResponse, result: ImageResult): SettledResult {
  return result.status === "completed"
    ? { status: "completed", result, artifactId: storedArtifactId(response, result), error: undefined }
    : { status: "failed", result, artifactId: null, error: result.message ?? "Processing failed." };
}
