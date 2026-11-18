/**
 * Runs one background image job from the browser's side:
 *
 *   create the job → for each file: get an authorization, upload it straight
 *   to storage, confirm it → poll the job until the worker has finished.
 *
 * The job lives on the server. If this tab closes after the uploads are
 * confirmed, the job still runs to completion and appears in History.
 *
 * The runner has no React or DOM dependency: its collaborators are passed in,
 * so it can be driven in a test without a browser.
 */
import type { UploadFn, UploadProgress } from "@/features/images/directUpload";
import type { CreateImageJobResponse, ImageJob, ImageJobItem, ImageOptimizeResponse, ImageOptimizeSettings, ImageResult, UploadGrantView } from "@/types/domain";

/** The API calls the runner needs. `api-client` satisfies this. */
export type JobApi = {
  post: <T>(path: string, body?: unknown) => Promise<T>;
  get: <T>(path: string) => Promise<T>;
  del: <T>(path: string) => Promise<T>;
};

export type DirectFilePhase =
  /** Not sent yet. */
  | "pending"
  | "uploading"
  /** The upload failed after its automatic retries. It can be retried or skipped. */
  | "upload_failed"
  /** Uploaded and confirmed; waiting for the worker. */
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export type DirectFile = {
  /** Key of the queue entry this file belongs to. */
  key: string;
  uploadId: string | null;
  phase: DirectFilePhase;
  /** Bytes sent so far, from the transfer's own progress events. */
  loaded: number;
  total: number;
  error: string | null;
};

export type DirectRunPhase =
  | "idle"
  | "creating"
  | "uploading"
  /** One or more uploads failed; waiting for the user to retry or skip them. */
  | "upload_stalled"
  /** Every file is with the server; waiting for the worker to finish. */
  | "waiting"
  | "finished"
  /** The job could not be created or followed. */
  | "error";

export type DirectRunState = {
  phase: DirectRunPhase;
  job: ImageJob | null;
  files: DirectFile[];
  error: { message: string; hint?: string } | null;
  cancelling: boolean;
};

const TERMINAL = new Set(["completed", "partial", "failed", "cancelled"]);
export const isTerminal = (job: ImageJob | null): boolean => job !== null && TERMINAL.has(job.state);

type ErrorLike = { message: string; hint?: string; code?: string; status?: number };
const describe = (error: unknown, fallback: string): { message: string; hint?: string } => {
  const known = error as Partial<ErrorLike> | null;
  return { message: typeof known?.message === "string" && known.message ? known.message : fallback, hint: typeof known?.hint === "string" ? known.hint : undefined };
};

const phaseOf = (item: ImageJobItem): DirectFilePhase =>
  item.state === "awaiting_upload" ? "pending" : item.state === "uploaded" ? "queued" : item.state;

export type DirectJobOptions = {
  api: JobApi;
  upload: UploadFn;
  onChange: (state: DirectRunState) => void;
  /** Milliseconds between status requests while the worker runs. */
  pollMs?: number;
  /** Extra attempts for an upload that fails, before the user is asked. */
  uploadRetries?: number;
  /** Creates the idempotency key of a run. Injected so that a test can fix it. */
  newKey?: () => string;
};

export class DirectJobRunner {
  private state: DirectRunState = { phase: "idle", job: null, files: [], error: null, cancelling: false };
  private sources = new Map<string, File>();
  private abort: AbortController | null = null;
  private disposed = false;
  private generation = 0;

  constructor(private readonly options: DirectJobOptions) {}

  get current(): DirectRunState {
    return this.state;
  }

  private set(patch: Partial<DirectRunState>): void {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.options.onChange(this.state);
  }

  private setFile(key: string, patch: Partial<DirectFile>): void {
    this.set({ files: this.state.files.map((file) => (file.key === key ? { ...file, ...patch } : file)) });
  }

  /** Takes the server's view of the job as the truth for every file that has reached the server. */
  private adopt(job: ImageJob): void {
    const byId = new Map(job.items.map((item) => [item.id, item]));
    this.set({
      job,
      files: this.state.files.map((file) => {
        const item = file.uploadId ? byId.get(file.uploadId) : undefined;
        if (!item) return file;
        // A file that is still being sent is described by the transfer, not by the server.
        if (item.state === "awaiting_upload") return file;
        return { ...file, phase: phaseOf(item), error: item.message, loaded: file.total };
      }),
    });
  }

  /** Starts a job for these files. The key of each entry identifies it in the state that is reported back. */
  async start(entries: Array<{ key: string; file: File }>, settings: ImageOptimizeSettings): Promise<void> {
    const generation = (this.generation += 1);
    this.sources = new Map(entries.map((entry) => [entry.key, entry.file]));
    this.abort = new AbortController();
    this.set({
      phase: "creating",
      job: null,
      error: null,
      cancelling: false,
      files: entries.map((entry) => ({ key: entry.key, uploadId: null, phase: "pending", loaded: 0, total: entry.file.size, error: null })),
    });
    let created: CreateImageJobResponse;
    try {
      created = await this.options.api.post<CreateImageJobResponse>("/api/v1/jobs/image-optimization", {
        files: entries.map((entry) => ({ name: entry.file.name, type: entry.file.type, size: entry.file.size })),
        settings,
        // The same key is sent if this request is repeated, so a retry cannot create a second job.
        idempotencyKey: (this.options.newKey ?? defaultKey)(),
      });
    } catch (error) {
      if (generation === this.generation) this.set({ phase: "error", error: describe(error, "The job could not be created.") });
      return;
    }
    if (generation !== this.generation) return;
    // Files are matched by position: the server keeps the order they were declared in.
    this.set({ job: created.job, files: this.state.files.map((file, index) => ({ ...file, uploadId: created.job.items[index]?.id ?? null })) });
    await this.uploadPending(generation);
  }

  /** Uploads every file that has not been sent, one after the other. */
  private async uploadPending(generation: number): Promise<void> {
    this.set({ phase: "uploading", error: null });
    const retries = this.options.uploadRetries ?? 2;
    for (const file of this.state.files.filter((candidate) => candidate.phase === "pending" || candidate.phase === "upload_failed")) {
      if (generation !== this.generation || this.state.cancelling) return;
      const source = this.sources.get(file.key);
      if (!source || !file.uploadId) continue;
      let lastError = "The upload failed.";
      let sent = false;
      for (let attempt = 0; attempt <= retries && !sent; attempt += 1) {
        if (generation !== this.generation || this.state.cancelling) return;
        this.setFile(file.key, { phase: "uploading", loaded: 0, error: null });
        try {
          // A fresh authorization for every attempt: they are short-lived on purpose.
          const { upload } = await this.options.api.post<{ upload: UploadGrantView }>("/api/v1/uploads/token", { uploadId: file.uploadId });
          await this.options.upload(upload, source, {
            signal: (this.abort ??= new AbortController()).signal,
            onProgress: (progress: UploadProgress) => {
              if (generation === this.generation) this.setFile(file.key, { loaded: Math.min(progress.loaded, source.size), total: source.size });
            },
          });
          const confirmed = await this.options.api.post<{ job: ImageJob; queued: boolean }>("/api/v1/uploads/complete", { uploadId: file.uploadId });
          if (generation !== this.generation) return;
          this.adopt(confirmed.job);
          sent = true;
        } catch (error) {
          if (this.state.cancelling || (error as { aborted?: boolean } | null)?.aborted) return;
          lastError = describe(error, "The upload failed.").message;
          // A refusal that will not change on a second try: stop retrying this file.
          const status = (error as ErrorLike | null)?.status;
          if (status !== undefined && status >= 400 && status < 500 && status !== 409 && status !== 429) break;
        }
      }
      if (!sent && generation === this.generation) this.setFile(file.key, { phase: "upload_failed", error: lastError, loaded: 0 });
    }
    if (generation !== this.generation) return;
    if (this.state.files.some((file) => file.phase === "upload_failed")) {
      this.set({ phase: "upload_stalled" });
      return;
    }
    await this.follow(generation);
  }

  /** Tries the failed uploads again. */
  async retryUploads(): Promise<void> {
    if (this.state.phase !== "upload_stalled") return;
    await this.uploadPending(this.generation);
  }

  /** Drops the files whose upload failed and lets the job continue with the rest. */
  async skipFailedUploads(): Promise<void> {
    if (this.state.phase !== "upload_stalled") return;
    const generation = this.generation;
    for (const file of this.state.files.filter((candidate) => candidate.phase === "upload_failed")) {
      if (!file.uploadId) continue;
      try {
        const { job } = await this.options.api.del<{ job: ImageJob }>(`/api/v1/uploads/${file.uploadId}`);
        if (generation === this.generation) this.adopt(job);
      } catch (error) {
        this.set({ phase: "error", error: describe(error, "The file could not be removed from the job.") });
        return;
      }
    }
    await this.follow(generation);
  }

  /** Asks the server for the job until the worker has finished it. */
  private async follow(generation: number): Promise<void> {
    if (!this.state.job) return;
    this.set({ phase: "waiting" });
    const jobId = this.state.job.id;
    let failures = 0;
    let wait = this.options.pollMs ?? 1500;
    while (generation === this.generation && !this.disposed) {
      try {
        const { job } = await this.options.api.get<{ job: ImageJob }>(`/api/v1/jobs/${jobId}`);
        if (generation !== this.generation) return;
        failures = 0;
        this.adopt(job);
        if (isTerminal(job)) {
          this.set({ phase: "finished", cancelling: false });
          return;
        }
      } catch (error) {
        failures += 1;
        // The job keeps running on the server whether or not this tab can reach it.
        if (failures >= 5) {
          this.set({ phase: "error", error: { ...describe(error, "The job's status could not be read."), hint: "The job continues on the server. Open History to see its result." } });
          return;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
      wait = Math.min(Math.round(wait * 1.15), 4000);
    }
  }

  /** Stops uploads that are in progress and asks the server to cancel the job. */
  async cancel(): Promise<void> {
    const job = this.state.job;
    this.set({ cancelling: true });
    this.abort?.abort();
    this.abort = null;
    if (!job || isTerminal(job)) {
      this.set({ phase: job ? "finished" : "idle", cancelling: false });
      return;
    }
    const generation = this.generation;
    try {
      const cancelled = await this.options.api.post<{ job: ImageJob }>(`/api/v1/jobs/${job.id}/cancel`);
      if (generation !== this.generation) return;
      this.adopt(cancelled.job);
      // A worker that is in the middle of a file finishes it first; follow until it stops.
      if (isTerminal(cancelled.job)) this.set({ phase: "finished", cancelling: false, files: this.state.files.map((file) => (file.phase === "pending" || file.phase === "uploading" || file.phase === "upload_failed" ? { ...file, phase: "cancelled" } : file)) });
      else await this.follow(generation);
    } catch (error) {
      this.set({ phase: "error", cancelling: false, error: describe(error, "The job could not be cancelled.") });
    }
  }

  /** Runs the files again whose failure was temporary. */
  async retryFailed(): Promise<void> {
    const job = this.state.job;
    if (!job || this.state.phase !== "finished") return;
    const generation = this.generation;
    try {
      const retried = await this.options.api.post<{ job: ImageJob }>(`/api/v1/jobs/${job.id}/retry`);
      if (generation !== this.generation) return;
      this.adopt(retried.job);
      await this.follow(generation);
    } catch (error) {
      this.set({ error: describe(error, "The failed files could not be retried.") });
    }
  }

  /** Forgets the job in this tab. The job itself is not touched. */
  reset(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    this.sources.clear();
    this.set({ phase: "idle", job: null, files: [], error: null, cancelling: false });
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.abort?.abort();
  }
}

function defaultKey(): string {
  return `web-${crypto.randomUUID()}`;
}

/**
 * The finished job in the shape the results panel reads. Every file of a
 * background job is stored, so each converted file has a download by URL.
 */
export function responseFromJob(job: ImageJob): ImageOptimizeResponse {
  const results: ImageResult[] = job.items
    .filter((item) => item.state === "completed" || item.state === "failed")
    .map((item) =>
      item.state === "completed" && item.result
        ? {
            id: item.artifactId ?? item.id,
            artifactId: item.artifactAvailable ? item.artifactId : null,
            filename: item.filename,
            outputFilename: item.result.outputFilename,
            status: "completed" as const,
            inputContentType: "",
            durationMs: item.result.durationMs,
            inputBytes: item.result.inputBytes,
            outputBytes: item.result.outputBytes,
            savedBytes: item.result.savedBytes,
            savingsPercent: item.result.savingsPercent,
            inputWidth: item.result.inputWidth,
            inputHeight: item.result.inputHeight,
            outputWidth: item.result.outputWidth,
            outputHeight: item.result.outputHeight,
            outputFormat: item.result.outputFormat,
            retainedOriginal: item.result.retainedOriginal,
          }
        : {
            id: item.id,
            artifactId: null,
            filename: item.filename,
            outputFilename: item.filename,
            status: "failed" as const,
            inputContentType: "",
            durationMs: 0,
            inputBytes: item.bytes,
            outputBytes: 0,
            savedBytes: 0,
            savingsPercent: 0,
            inputWidth: null,
            inputHeight: null,
            outputWidth: null,
            outputHeight: null,
            outputFormat: "—",
            errorCode: item.errorCode ?? "processing_failed",
            message: item.message ?? "The file could not be processed.",
          },
    );
  const completed = results.filter((result) => result.status === "completed").length;
  return {
    jobId: job.id,
    persisted: true,
    storage: { persisted: true },
    status: completed === 0 ? "failed" : completed === results.length ? "completed" : "partial",
    results,
    totals: { inputBytes: job.totals.inputBytes, outputBytes: job.totals.outputBytes, savedBytes: job.totals.savedBytes, savingsPercent: job.totals.savingsPercent ?? 0 },
  };
}
