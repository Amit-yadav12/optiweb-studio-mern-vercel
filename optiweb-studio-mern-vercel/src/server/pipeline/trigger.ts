/**
 * Starting the worker.
 *
 * Accepted work lives in MongoDB, not in this process: a job is a record with
 * a state and a lease, and any worker invocation can pick it up. This module
 * only decides how soon one does.
 *
 *  - `inline` (default): the worker runs in the invocation that accepted the
 *    work, after the response has been sent. On Vercel, `waitUntil` keeps the
 *    function alive for it, up to the function's maximum duration.
 *  - `manual`: nothing is started here. For tests that drive the worker.
 *
 * If that invocation dies, the job is not lost. It is picked up again by the
 * next status request for it, by the next accepted job, or by the scheduled
 * sweep, once its lease has lapsed.
 */
import { waitUntil } from "@vercel/functions";

export function workerTrigger(): "inline" | "manual" {
  return (process.env.OW_JOB_TRIGGER ?? "").trim().toLowerCase() === "manual" ? "manual" : "inline";
}

/** Worker runs started by this process, tracked so that tests and a shutdown can wait for them. */
const running = new Set<Promise<unknown>>();

/** Asks for a worker run. Returns immediately. Never throws. */
export function kickWorker(): void {
  if (workerTrigger() === "manual") return;
  // The worker is imported here, not at the top, because it imports this module's callers.
  const run = import("./worker.js")
    .then((worker) => worker.drainJobs())
    .catch((error: unknown) => {
      console.error(`[pipeline] worker run failed (${error instanceof Error ? error.name : "unknown error"})`);
    });
  running.add(run);
  void run.finally(() => running.delete(run));
  try {
    // Outside Vercel there is no request context and this is a no-op; the
    // promise still runs to completion in the long-lived process.
    waitUntil(run);
  } catch {
    /* the run continues regardless */
  }
}

/** Resolves when every worker run started by this process has ended. */
export async function workerIdle(): Promise<void> {
  while (running.size > 0) await Promise.allSettled([...running]);
}
