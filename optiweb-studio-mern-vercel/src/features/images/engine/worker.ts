/**
 * The image worker. It receives a file from its own page, processes it with
 * the pipeline and answers with the encoded files. It talks to nothing else.
 */
import { JobError, offscreenBackend, runJob } from "./pipeline";
import type { WorkerRequest, WorkerResponse } from "./types";

const scope = self as unknown as {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
};

const backend = offscreenBackend();

scope.addEventListener("message", (event) => {
  const request = event.data;
  if (request?.type !== "run") return;
  const { job } = request;
  runJob(job, backend, {
    stage: (stage, detail) => scope.postMessage({ type: "stage", id: job.id, stage, detail }),
    // A worker is cancelled by terminating it, so there is nothing to check here.
    cancelled: () => false,
  }).then(
    (result) => scope.postMessage({ type: "done", result }),
    (error: unknown) => {
      const failure =
        error instanceof JobError
          ? { id: job.id, code: error.code, message: error.message, hint: error.hint }
          : { id: job.id, code: "internal" as const, message: error instanceof Error ? error.message : "The image could not be processed.", hint: "Try again. If it keeps failing, the file may be damaged." };
      scope.postMessage({ type: "failed", failure });
    },
  );
});

scope.postMessage({ type: "ready" });
