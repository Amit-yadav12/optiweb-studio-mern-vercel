/**
 * Settings, kept in this browser's localStorage.
 *
 * They never leave the browser: there is no account and no server-side copy.
 * Clearing the site's data, or using another browser, starts from the defaults.
 */
import { useSyncExternalStore } from "react";
import { clampDimension, clampQuality, isFormatChoice } from "@/features/images/engine/plan";
import type { FormatChoice, Strategy } from "@/features/images/engine/types";
import { isFontDisplayPolicy, type FontDisplayPolicy } from "@/shared/css";
import { PREFERENCES_STORAGE_KEY } from "@/lib/storage-keys";

export type Preferences = {
  defaultImageFormat: FormatChoice;
  defaultStrategy: Strategy;
  defaultQuality: number;
  defaultMaxWidth: number | null;
  fontDisplayPolicy: FontDisplayPolicy;
  analyzerThresholdKb: number;
  reduceMotion: boolean;
};

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  defaultImageFormat: "webp",
  defaultStrategy: "single",
  defaultQuality: 78,
  defaultMaxWidth: null,
  fontDisplayPolicy: "swap",
  analyzerThresholdKb: 300,
  reduceMotion: false,
});

export const THRESHOLD_KB_MIN = 50;
export const THRESHOLD_KB_MAX = 10_000;

const STRATEGIES: readonly Strategy[] = ["single", "best-effort", "no-regression"];

/** Turns anything read from storage into valid settings. Each field that is missing or invalid takes its default. */
export function normalizePreferences(raw: unknown): Preferences {
  const input = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const threshold = Number(input.analyzerThresholdKb);
  return {
    defaultImageFormat: isFormatChoice(input.defaultImageFormat) ? input.defaultImageFormat : DEFAULT_PREFERENCES.defaultImageFormat,
    defaultStrategy: STRATEGIES.includes(input.defaultStrategy as Strategy) ? (input.defaultStrategy as Strategy) : DEFAULT_PREFERENCES.defaultStrategy,
    defaultQuality: typeof input.defaultQuality === "number" ? clampQuality(input.defaultQuality) : DEFAULT_PREFERENCES.defaultQuality,
    defaultMaxWidth: typeof input.defaultMaxWidth === "number" ? clampDimension(input.defaultMaxWidth) : null,
    fontDisplayPolicy: isFontDisplayPolicy(input.fontDisplayPolicy) ? input.fontDisplayPolicy : DEFAULT_PREFERENCES.fontDisplayPolicy,
    analyzerThresholdKb: Number.isFinite(threshold) && threshold > 0 ? Math.min(THRESHOLD_KB_MAX, Math.max(THRESHOLD_KB_MIN, Math.round(threshold))) : DEFAULT_PREFERENCES.analyzerThresholdKb,
    reduceMotion: input.reduceMotion === true,
  };
}

let cached: Preferences | null = null;
const listeners = new Set<() => void>();

function read(): Preferences {
  try {
    const stored = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    return normalizePreferences(stored ? JSON.parse(stored) : null);
  } catch {
    // Storage is blocked or holds something that is not JSON: use the defaults.
    return { ...DEFAULT_PREFERENCES };
  }
}

export function getPreferences(): Preferences {
  cached ??= read();
  return cached;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Saves the settings. Returns false when the browser refused to store them
 * (private browsing in some browsers, or storage turned off): they then apply
 * until the page is reloaded.
 */
export function savePreferences(next: Preferences): boolean {
  cached = normalizePreferences(next);
  let stored = true;
  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(cached));
  } catch {
    stored = false;
  }
  notify();
  return stored;
}

/** Removes the stored settings, so the defaults apply again. */
export function resetPreferences(): void {
  cached = { ...DEFAULT_PREFERENCES };
  try {
    window.localStorage.removeItem(PREFERENCES_STORAGE_KEY);
  } catch {
    /* nothing was stored */
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab of this site changed the settings.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== PREFERENCES_STORAGE_KEY) return;
    cached = read();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The current settings. The component re-renders when they change, in this tab or another. */
export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, getPreferences, () => DEFAULT_PREFERENCES);
}

/** Test hook: forget what was read, so the next read comes from storage. */
export function forgetCachedPreferences(): void {
  cached = null;
}
