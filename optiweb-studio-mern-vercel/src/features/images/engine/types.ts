/**
 * Types shared by the image engine: the planner, the worker and the interface.
 *
 * The engine runs in the browser tab. Nothing in these types leaves it: the
 * messages below travel between the page and its own Web Worker only.
 */
import type { ImageFormat as SourceFormat } from "@/shared/imageHeader";

export type { SourceFormat };

/** Formats the engine can write. */
export type OutputFormat = "webp" | "avif" | "jpeg" | "png";
/** What the user picks. `original` keeps each file's own format. */
export type FormatChoice = OutputFormat | "original";
/**
 * - `single`: write the chosen format; the result is reported as it is.
 * - `best-effort`: try several formats and keep the smallest result.
 * - `no-regression`: as `best-effort`, but keep the original file when no result is smaller.
 */
export type Strategy = "single" | "best-effort" | "no-regression";

export type OptimizeSettings = {
  format: FormatChoice;
  /** 30–100. Not used for PNG, which is lossless. */
  quality: number;
  /** Largest output width in pixels, or null for no limit. Images are never enlarged. */
  maxWidth: number | null;
  maxHeight: number | null;
  strategy: Strategy;
};

/** What a file's header says, after validation. Sizes are as displayed (rotation applied). */
export type SourceInfo = {
  format: SourceFormat;
  mime: string;
  width: number;
  height: number;
  /** EXIF orientation 1–8, or null. */
  orientation: number | null;
  /** Whether the file can carry transparency, according to its header. */
  mayHaveAlpha: boolean;
  metadata: { exif: boolean; gps: boolean; icc: boolean; xmp: boolean };
  traits: string[];
  /** Set when the file's name suggests a different format than its contents. */
  nameMismatch: string | null;
};

export type RejectCode =
  | "empty"
  | "not_an_image"
  | "vector"
  | "damaged"
  | "animated"
  | "too_many_pixels"
  | "unreadable";

export type Inspection =
  | { ok: true; source: SourceInfo }
  | { ok: false; code: RejectCode; message: string; hint: string };

/** One encode the worker is asked to attempt. */
export type CandidatePlan = {
  format: OutputFormat;
  quality: number;
  /** Shown in the result table, for example "lossy WebP". */
  note: string;
  /** Skip this candidate when the decoded image uses transparency (JPEG in a multi-format comparison). */
  requiresOpaque: boolean;
};

/** A candidate that was planned but will not be attempted, with the reason. */
export type SkippedCandidate = { format: OutputFormat; quality: number; note: string };

export type JobRequest = {
  id: string;
  file: Blob;
  /** Header facts, used to cross-check the decoder and to decide whether to look for transparency. */
  source: Pick<SourceInfo, "format" | "width" | "height" | "orientation" | "mayHaveAlpha">;
  maxWidth: number | null;
  maxHeight: number | null;
  candidates: CandidatePlan[];
  /** Upper bound on the pixels of an AVIF this device should be asked to encode. */
  avifMaxPixels: number;
};

export type CandidateOutcome = {
  format: OutputFormat;
  quality: number;
  note: string;
  /** The encoded file, or null when this candidate was skipped or failed. */
  blob: Blob | null;
  /** Why there is no file. Null when there is one. */
  problem: string | null;
  /** How the bytes were produced: by the browser's own encoder or by a WebAssembly codec. */
  encoder: "browser" | "wasm" | null;
  ms: number;
};

export type JobResult = {
  id: string;
  /** Size of the decoded source, as the decoder reported it. */
  decodedWidth: number;
  decodedHeight: number;
  /** Size of every encoded candidate. */
  outputWidth: number;
  outputHeight: number;
  resized: boolean;
  /** True when at least one pixel is not fully opaque. Null when it was not checked because the format cannot carry alpha. */
  usesTransparency: boolean | null;
  /** True when transparency was replaced with white for a JPEG candidate. */
  flattened: boolean;
  candidates: CandidateOutcome[];
  decodeMs: number;
};

export type JobFailureCode =
  | "decode_failed"
  | "canvas_unavailable"
  | "canvas_too_large"
  | "encoder_unavailable"
  | "timeout"
  | "cancelled"
  | "worker_crashed"
  | "internal";

export type JobFailure = { id: string; code: JobFailureCode; message: string; hint: string };

export type JobStage = "queued" | "decoding" | "resizing" | "encoding";

/** Page → worker. */
export type WorkerRequest = { type: "run"; job: JobRequest };
/** Worker → page. */
export type WorkerResponse =
  | { type: "ready" }
  | { type: "stage"; id: string; stage: JobStage; detail?: string }
  | { type: "done"; result: JobResult }
  | { type: "failed"; failure: JobFailure };

/** The file a finished job offers, chosen from the candidates by the strategy. */
export type Selection = {
  /** Index into `JobResult.candidates`, or "original" when the source file itself is the result. */
  chosen: number | "original";
  keptOriginal: boolean;
  /** Why the original was kept. Null when it was not. */
  keptReason: string | null;
};
