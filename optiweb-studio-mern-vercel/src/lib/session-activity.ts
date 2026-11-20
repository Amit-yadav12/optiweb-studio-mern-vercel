/**
 * What the tools did since this page was loaded.
 *
 * It holds counts only: no file names and no file contents. It lives in this
 * tab's memory and is gone on reload. It exists so the Overview can show
 * something true without any record being kept anywhere.
 */
import { useSyncExternalStore } from "react";

export type ToolId = "images" | "fonts" | "assets" | "audit";

export type ToolActivity = {
  /** Times the tool finished a run. */
  runs: number;
  /** Files (or, for the audit, pages) the runs covered. */
  items: number;
  /** Bytes before and after, for tools that produce files. */
  inputBytes: number;
  outputBytes: number;
};

export type SessionActivity = Record<ToolId, ToolActivity>;

const empty = (): ToolActivity => ({ runs: 0, items: 0, inputBytes: 0, outputBytes: 0 });
let state: SessionActivity = { images: empty(), fonts: empty(), assets: empty(), audit: empty() };
const listeners = new Set<() => void>();

export function recordActivity(tool: ToolId, entry: { items: number; inputBytes?: number; outputBytes?: number }): void {
  const current = state[tool];
  state = {
    ...state,
    [tool]: {
      runs: current.runs + 1,
      items: current.items + entry.items,
      inputBytes: current.inputBytes + (entry.inputBytes ?? 0),
      outputBytes: current.outputBytes + (entry.outputBytes ?? 0),
    },
  };
  for (const listener of listeners) listener();
}

export function getActivity(): SessionActivity {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSessionActivity(): SessionActivity {
  return useSyncExternalStore(subscribe, getActivity, getActivity);
}

/** Test hook. */
export function resetActivity(): void {
  state = { images: empty(), fonts: empty(), assets: empty(), audit: empty() };
  for (const listener of listeners) listener();
}
