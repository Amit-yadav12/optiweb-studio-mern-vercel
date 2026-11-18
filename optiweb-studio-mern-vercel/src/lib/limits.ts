/**
 * The limits this deployment enforces, as the server reports them.
 *
 * Every number the interface shows about sizes, counts and retention comes
 * from here. The interface has no limits of its own: when the server's
 * configuration changes, the pages show the new numbers without a rebuild.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type { ImageCapacity } from "@/types/domain";

export type ServerLimits = {
  /** Limits of requests that carry files in their body (standard uploads, Asset Analyzer). */
  maxFileBytes: number;
  maxFilesPerRequest: number;
  maxBatchBytes?: number;
  maxAssetFiles?: number;
  maxDecodedPixels: number;
  maxCssChars?: number;
  artifactTtlHours: number;
  avifSupported: boolean;
  auditMaxPages?: number;
  auditMaxResources?: number;
  auditMaxHtmlBytes?: number;
  auditMaxResourceBytes?: number;
  auditMaxTotalBytes?: number;
  /** The Image Optimizer's limits in the mode that is in effect. */
  image?: ImageCapacity;
};

/** Used only until the server has answered, and when it cannot be reached. */
export const FALLBACK_LIMITS: ServerLimits = {
  maxFileBytes: 1_048_576,
  maxFilesPerRequest: 4,
  maxBatchBytes: 3_984_588,
  maxDecodedPixels: 24_000_000,
  artifactTtlHours: 720,
  avifSupported: false,
};

let pending: Promise<ServerLimits> | null = null;

/** One request per page load, shared by every component that asks. A failed request is retried by the next caller. */
function loadLimits(): Promise<ServerLimits> {
  pending ??= api.get<ServerLimits>("/api/v1/limits").catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

/** The server's limits. `known` is false until they have arrived; until then `limits` holds placeholders that must not be shown as facts. */
export function useServerLimits(): { limits: ServerLimits; known: boolean } {
  const [state, setState] = useState<{ limits: ServerLimits; known: boolean }>({ limits: FALLBACK_LIMITS, known: false });
  useEffect(() => {
    let active = true;
    loadLimits().then(
      (limits) => {
        if (active) setState({ limits, known: true });
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);
  return state;
}

const MB = 1024 * 1024;
export const wholeMb = (bytes: number): number => Math.max(1, Math.floor(bytes / MB));
/** A size in MB with at most one decimal, without a trailing ".0". */
export const mbLabel = (bytes: number): string => String(Math.round((bytes / MB) * 10) / 10);
