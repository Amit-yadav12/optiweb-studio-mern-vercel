/**
 * What an image optimization response means for the person looking at it.
 *
 * A response answers two separate questions: were the files converted
 * (`status`), and were the results stored (`persisted`). This module turns the
 * two answers into one of three outcomes, so every part of the screen (banner,
 * badges, toast, download links) is driven by the same decision.
 *
 * It also decides where a download comes from. A stored file is downloaded by
 * URL (`storedArtifactId`). A file that was not stored can only be saved from
 * the bytes the response carried (`inlineOutputOf`), and only in this tab.
 *
 * It is pure and has no React or browser dependency, so it can be tested
 * directly.
 */
import type { Tone } from "@/lib/status";
import type { ImageOptimizeResponse, ImageResult, InlineOutput, StorageFailureCategory } from "@/types/domain";

export type ImageOutcomeKind =
  /** At least one file was converted, and the job and its output files are stored. */
  | "stored"
  /** At least one file was converted, but nothing was stored: no stored downloads and no history entry. */
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
  /** True only when output files are stored. Downloads by URL, the server's ZIP and history links depend on it. */
  downloadsAvailable: boolean;
  /**
   * Converted files of this run that can be saved from this tab only, because
   * their bytes came with the response. Always 0 when the run is stored.
   */
  tabDownloads: number;
  /** History ID of the stored job, or null when there is no history entry. */
  historyJobId: string | null;
  toast: { tone: Tone; title: string; description: string | null };
  counts: { submitted: number; converted: number; failed: number };
};

const files = (count: number): string => `${count} file${count === 1 ? "" : "s"}`;

/** Wording used when a response says nothing was stored but gives no reason. */
const UNKNOWN_STORAGE_FAILURE = "Storage is unavailable.";

/**
 * Both fields come from the same server value. A response counts as stored
 * only when neither of them says otherwise.
 */
const isStored = (response: ImageOptimizeResponse): boolean => response.persisted === true && response.storage?.persisted !== false;

export function describeImageOutcome(response: ImageOptimizeResponse): ImageOutcome {
  const submitted = response.results.length;
  const converted = response.results.filter((result) => result.status === "completed").length;
  const failed = submitted - converted;
  const counts = { submitted, converted, failed };

  const stored = isStored(response);
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
  const tabDownloads = response.results.filter((result) => inlineOutputOf(response, result) !== null).length;
  const shared = { storageFailure, conversion, storage, counts, tabDownloads };

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
    const one = converted === 1;
    const reason = storageFailure?.message ?? UNKNOWN_STORAGE_FAILURE;
    // What can still be done with the converted files. Nothing here may read
    // as a stored download: the copies exist in this tab and nowhere else.
    const delivery =
      tabDownloads === 0
        ? `${one ? "It" : "They"} cannot be downloaded, and this run is not in History.`
        : tabDownloads === converted
          ? `Download ${one ? "it" : "them"} now: ${one ? "the copy exists" : "the copies exist"} only in this tab and ${one ? "is" : "are"} gone when you reload or leave the page. This run is not in History.`
          : `${tabDownloads} of them can be downloaded now, from this tab only. The ${converted - tabDownloads === 1 ? "other is" : "others are"} too large to send back without storage. This run is not in History.`;
    return {
      ...shared,
      kind: "converted_not_stored",
      tone: "warn",
      title: "Converted, but not stored",
      message: `${files(converted)} ${one ? "was" : "were"} converted, but the output could not be stored. ${delivery}${rejected}`,
      downloadsAvailable: false,
      historyJobId: null,
      toast: {
        tone: "warn",
        title: "Converted, but not stored",
        description:
          tabDownloads === 0
            ? `Nothing can be downloaded for this run. ${reason}`
            : tabDownloads === converted
              ? `Download ${one ? "the file now; it is" : "the files now; they are"} kept only in this tab. ${reason}`
              : `${tabDownloads} of ${converted} files can be downloaded now, from this tab only. ${reason}`,
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
  if (!isStored(response) || result.status !== "completed") return null;
  return typeof result.artifactId === "string" && result.artifactId.length > 0 ? result.artifactId : null;
}

/**
 * The output file that came inside the response for this result, or null.
 *
 * It is used only when the run was not stored, the file was converted, and the
 * payload has exactly the size the result reports. A stored run never uses it:
 * its files are downloaded by URL.
 */
export function inlineOutputOf(response: ImageOptimizeResponse, result: ImageResult): InlineOutput | null {
  if (isStored(response) || result.status !== "completed") return null;
  const inline = result.inlineOutput;
  if (!inline || inline.encoding !== "base64" || typeof inline.data !== "string" || typeof inline.contentType !== "string") return null;
  if (!Number.isInteger(inline.bytes) || inline.bytes <= 0 || inline.bytes !== result.outputBytes) return null;
  // Padded Base64 of n bytes is exactly 4 × ⌈n / 3⌉ characters long.
  return inline.data.length === 4 * Math.ceil(inline.bytes / 3) ? inline : null;
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
