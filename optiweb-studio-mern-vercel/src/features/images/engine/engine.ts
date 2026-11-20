/**
 * Runs image jobs on a small pool of Web Workers.
 *
 * - At most `limits.concurrency` files are in work at once, and their decoded
 *   pixels together stay inside `limits.pixelBudget`.
 * - Cancelling terminates the workers. That is the only way to stop a decode
 *   or an encode that is already running, and it frees their memory at once.
 * - A file that runs past its time limit is stopped the same way; the other
 *   files continue.
 * - In a browser without canvases in workers, the same pipeline runs on the
 *   page itself, one file at a time.
 */
import { nextToStart, type EngineLimits } from "./plan";
import type { JobFailure, JobRequest, JobResult, JobStage, WorkerRequest, WorkerResponse } from "./types";

export type EngineEvents = {
  stage(id: string, stage: JobStage, detail?: string): void;
  done(id: string, result: JobResult): void;
  failed(id: string, failure: JobFailure): void;
};

export type EngineJob = { request: JobRequest; pixels: number; timeoutMs: number };

/** What the interface needs from an engine. Tests supply their own. */
export type ImageEngine = {
  submit(jobs: EngineJob[], events: EngineEvents): void;
  /** Stops everything that is waiting or running. Each stopped job is reported as failed with code `cancelled`. */
  cancelAll(): void;
  /** True while a job is waiting or running. */
  busy(): boolean;
  dispose(): void;
};

export type WorkerLike = {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerResponse>) => void): void;
  addEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
};

/** `order` is the position in which the job was submitted. */
type Waiting = EngineJob & { events: EngineEvents; order: number };
type Running = Waiting & { worker: WorkerLike | null; timer: ReturnType<typeof setTimeout> | null; cancelled: boolean };

/** True when this browser can decode, draw and encode inside a worker. */
export function workersCanProcessImages(): boolean {
  return typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function";
}

function defaultWorker(): WorkerLike {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "unikit-image-worker" }) as unknown as WorkerLike;
}

const CANCELLED = (id: string): JobFailure => ({ id, code: "cancelled", message: "Cancelled before it finished.", hint: "" });

export function createImageEngine(options: { limits: EngineLimits; createWorker?: () => WorkerLike; mode?: "auto" | "page" }): ImageEngine {
  const { limits } = options;
  const createWorker = options.createWorker ?? defaultWorker;
  let mode: "worker" | "page" = options.mode === "page" || (!options.createWorker && !workersCanProcessImages()) ? "page" : "worker";
  const waiting: Waiting[] = [];
  const running = new Map<string, Running>();
  const idle: WorkerLike[] = [];
  /** Workers that have announced themselves. A worker that fails before that never worked in this browser. */
  const ready = new WeakSet<WorkerLike>();
  let disposed = false;
  let submitted = 0;

  const finish = (job: Running, report: () => void) => {
    if (running.get(job.request.id) !== job) return;
    running.delete(job.request.id);
    if (job.timer) clearTimeout(job.timer);
    report();
    pump();
  };

  const retire = (worker: WorkerLike | null) => {
    if (!worker) return;
    try {
      worker.terminate();
    } catch {
      /* already gone */
    }
  };

  const fallBackToPage = (job: Running) => {
    // Workers do not work here. Use the page for this job and every later one.
    mode = "page";
    for (const worker of idle.splice(0)) retire(worker);
    retire(job.worker);
    job.worker = null;
    if (job.timer) clearTimeout(job.timer);
    running.delete(job.request.id);
    // Back into the queue at the place it was submitted in, so that several
    // workers failing one after another do not reverse the order of their files.
    const position = waiting.findIndex((other) => other.order > job.order);
    waiting.splice(position === -1 ? waiting.length : position, 0, job);
    pump();
  };

  const startOnWorker = (job: Running) => {
    let worker = idle.pop() ?? null;
    if (!worker) {
      try {
        worker = createWorker();
      } catch {
        fallBackToPage(job);
        return;
      }
      const created = worker;
      created.addEventListener("message", (event) => {
        const message = event.data;
        if (message.type === "ready") {
          ready.add(created);
          return;
        }
        const current = [...running.values()].find((entry) => entry.worker === created);
        if (!current) return;
        if (message.type === "stage") current.events.stage(message.id, message.stage, message.detail);
        else if (message.type === "done") {
          current.worker = null;
          idle.push(created);
          finish(current, () => current.events.done(message.result.id, message.result));
        } else if (message.type === "failed") {
          if (message.failure.code === "canvas_unavailable" && mode === "worker") {
            fallBackToPage(current);
            return;
          }
          current.worker = null;
          idle.push(created);
          finish(current, () => current.events.failed(message.failure.id, message.failure));
        }
      });
      const crashed = () => {
        const current = [...running.values()].find((entry) => entry.worker === created);
        const index = idle.indexOf(created);
        if (index !== -1) idle.splice(index, 1);
        if (!current) {
          retire(created);
          return;
        }
        if (!ready.has(created)) {
          fallBackToPage(current);
          return;
        }
        retire(created);
        current.worker = null;
        finish(current, () =>
          current.events.failed(current.request.id, {
            id: current.request.id,
            code: "worker_crashed",
            message: "The browser stopped the worker that was processing this image.",
            hint: "This usually means the tab ran out of memory. Set a maximum width, process fewer files at once, or close other tabs.",
          }),
        );
      };
      created.addEventListener("error", crashed);
      created.addEventListener("messageerror", crashed);
    }
    job.worker = worker;
    job.timer = setTimeout(() => {
      retire(job.worker);
      job.worker = null;
      finish(job, () =>
        job.events.failed(job.request.id, {
          id: job.request.id,
          code: "timeout",
          message: `Stopped after ${Math.round(job.timeoutMs / 1000)} seconds without finishing.`,
          hint: "Set a maximum width, or choose WebP or JPEG instead of AVIF. The other files were not affected.",
        }),
      );
    }, job.timeoutMs);
    worker.postMessage({ type: "run", job: job.request });
  };

  const startOnPage = (job: Running) => {
    void (async () => {
      try {
        const { documentBackend, runJob } = await import("./pipeline");
        const result = await runJob(job.request, documentBackend(), {
          stage: (stage, detail) => {
            if (!job.cancelled) job.events.stage(job.request.id, stage, detail);
          },
          cancelled: () => job.cancelled,
        });
        finish(job, () => job.events.done(result.id, result));
      } catch (error) {
        // A JobError from the pipeline carries its own code and hint.
        const known = error as Partial<Pick<JobFailure, "code" | "hint">> | null;
        const failure: JobFailure =
          error instanceof Error && typeof known?.code === "string" && typeof known.hint === "string"
            ? { id: job.request.id, code: known.code, message: error.message, hint: known.hint }
            : { id: job.request.id, code: "internal", message: error instanceof Error ? error.message : "The image could not be processed.", hint: "Try again. If it keeps failing, the file may be damaged." };
        finish(job, () => job.events.failed(job.request.id, failure));
      }
    })();
  };

  function pump(): void {
    // One job is started per round, and the limits are read again each time:
    // starting a job can change them, when a worker turns out not to work and
    // the engine falls back to the page, where one file runs at a time.
    while (!disposed) {
      const cap = mode === "page" ? { concurrency: 1, pixelBudget: limits.pixelBudget } : limits;
      const [id] = nextToStart(
        waiting.map((job) => ({ id: job.request.id, pixels: job.pixels })),
        [...running.values()].map((job) => ({ pixels: job.pixels })),
        cap,
      );
      if (id === undefined) return;
      const index = waiting.findIndex((job) => job.request.id === id);
      if (index === -1) return;
      const job: Running = { ...waiting.splice(index, 1)[0], worker: null, timer: null, cancelled: false };
      running.set(id, job);
      if (mode === "page") startOnPage(job);
      else startOnWorker(job);
    }
  }

  return {
    submit(jobs, events) {
      if (disposed) return;
      for (const job of jobs) waiting.push({ ...job, events, order: (submitted += 1) });
      pump();
    },
    cancelAll() {
      const stopped: Array<Waiting | Running> = [...running.values(), ...waiting.splice(0)];
      for (const job of running.values()) {
        job.cancelled = true;
        if (job.timer) clearTimeout(job.timer);
        retire(job.worker);
        job.worker = null;
      }
      running.clear();
      for (const job of stopped) job.events.failed(job.request.id, CANCELLED(job.request.id));
    },
    busy: () => waiting.length > 0 || running.size > 0,
    dispose() {
      disposed = true;
      for (const job of running.values()) {
        job.cancelled = true;
        if (job.timer) clearTimeout(job.timer);
        retire(job.worker);
      }
      running.clear();
      waiting.length = 0;
      for (const worker of idle.splice(0)) retire(worker);
    },
  };
}
