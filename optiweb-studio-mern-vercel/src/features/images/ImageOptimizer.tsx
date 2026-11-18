import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Info, SlidersHorizontal, Trash2 } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { ErrorState, ProgressIndicator, useToast} from "@/components/ui/Feedback";
import { Field, Input, SegmentedControl } from "@/components/ui/Form";
import { FormatTag, Panel, PanelHeader } from "@/components/ui/Layout";
import { FileDropzone } from "@/components/ui/FileDropzone";
import { FileRow } from "@/components/ui/FileRow";
import { DirectJobRunner, isTerminal, responseFromJob, type DirectFile, type DirectRunState, type JobApi } from "@/features/images/directJob";
import { uploadToStorage, type UploadFn } from "@/features/images/directUpload";
import { ImageReview, type ItemStatus, type OptimizerItem } from "@/features/images/ImageReview";
import { createLocalOutput, releaseLocalOutput, zipLocalOutputs, type LocalOutput } from "@/features/images/localOutput";
import { describeImageOutcome, inlineOutputOf, settleResult } from "@/features/images/outcome";
import { takeStagedFiles } from "@/features/assets/transfer";
import { ApiClientError, api, artifactUrl, downloadZip, triggerDownload } from "@/lib/api-client";
import { clamp, formatBytes, formatDuration } from "@/lib/format";
import type { ImageOptimizeResponse, ImageOptimizeSettings, Preferences } from "@/types/domain";

type Item = OptimizerItem;

/** Releases the object URLs an upload holds: its preview and, if any, its converted copy. */
function releaseItem(item: Item): void {
  URL.revokeObjectURL(item.preview);
  releaseLocalOutput(item.localOutput);
}

export type OptimizerLimits = {
  maxFileMb: number;
  maxFiles: number;
  maxDecodedPixels: number;
  avifSupported: boolean;
  /**
   * How files reach the server. `direct`: the browser uploads to object
   * storage and a background job converts the files. `request` (the default):
   * files are sent inside one request and converted before it answers.
   */
  mode?: "direct" | "request";
  /** Combined size of the files of one batch, in MB. */
  maxBatchMb?: number;
  /** Hours a source upload is kept after its job, and a converted file after it was made. Direct mode only. */
  sourceTtlHours?: number | null;
  artifactTtlHours?: number;
};

/** The network collaborators of a background job. Replaced in tests. */
export type OptimizerTransport = { api: JobApi; upload: UploadFn };

const defaultTransport: OptimizerTransport = {
  api: { post: (path, body) => api.post(path, body), get: (path) => api.get(path), del: (path) => api.del(path) },
  upload: uploadToStorage,
};

/** What one file of a background job is doing, in words, from the transfer's and the job's own data. */
function directDetail(file: DirectFile): string {
  switch (file.phase) {
    case "pending":
      return "waiting to upload";
    case "uploading":
      return `uploading · ${formatBytes(file.loaded)} of ${formatBytes(file.total)} sent`;
    case "upload_failed":
      return "upload failed";
    case "queued":
      return "uploaded · waiting for the worker";
    case "processing":
      return "converting";
    case "completed":
      return "converted";
    case "failed":
      return "not converted";
    case "cancelled":
      return "cancelled";
  }
}

/** One line for the whole job, built from real counts only. */
function directSummary(state: DirectRunState): string {
  const total = state.files.length;
  if (state.cancelling) return "Cancelling…";
  if (state.phase === "creating") return "Creating the job…";
  if (state.phase === "uploading") {
    const sent = state.files.reduce((sum, file) => sum + (file.phase === "uploading" || file.phase === "pending" || file.phase === "upload_failed" ? file.loaded : file.total), 0);
    const all = state.files.reduce((sum, file) => sum + file.total, 0);
    const done = state.files.filter((file) => file.phase !== "pending" && file.phase !== "uploading" && file.phase !== "upload_failed").length;
    return `Uploading: ${done} of ${total} file${total === 1 ? "" : "s"} uploaded · ${formatBytes(sent)} of ${formatBytes(all)} sent`;
  }
  const counts = state.job?.counts;
  if (!counts) return "Waiting for the server…";
  const finished = counts.completed + counts.failed + counts.cancelled;
  if (state.job?.state === "queued" || state.job?.state === "uploaded") return `Waiting in the queue · ${finished} of ${counts.total} file${counts.total === 1 ? "" : "s"} finished`;
  return `Converting · ${finished} of ${counts.total} file${counts.total === 1 ? "" : "s"} finished`;
}

const FORMATS = [
  { value: "webp", label: "WebP" },
  { value: "avif", label: "AVIF" },
  { value: "jpeg", label: "JPEG" },
  { value: "png", label: "PNG" },
  { value: "original", label: "Keep" },
] as const;

export function ImageOptimizer({ limits, transport = defaultTransport, onJobSettled }: { limits: OptimizerLimits; transport?: OptimizerTransport; onJobSettled?: () => void }) {
  const { push } = useToast();
  const directMode = limits.mode === "direct";
  const [direct, setDirect] = useState<DirectRunState | null>(null);
  const runnerRef = useRef<DirectJobRunner | null>(null);
  const directStartedRef = useRef(0);
  const [items, setItems] = useState<Item[]>([]);
  const [format, setFormat] = useState<(typeof FORMATS)[number]["value"]>("webp");
  const [policy, setPolicy] = useState<"single" | "best-effort" | "no-regression">("single");
  const [quality, setQuality] = useState(78);
  const [maxWidth, setMaxWidth] = useState<string>("");
  const [maxHeight, setMaxHeight] = useState<string>("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; hint?: string } | null>(null);
  const [response, setResponse] = useState<ImageOptimizeResponse | null>(null);
  const [zipping, setZipping] = useState(false);
  const restored = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      // The job itself is not touched: it keeps running on the server and appears in History.
      runnerRef.current?.dispose();
      for (const item of itemsRef.current) releaseItem(item);
    };
  }, []);

  /* Saved defaults come from the real preferences row for this session. */
  useEffect(() => {
    api
      .get<Preferences>("/api/v1/preferences")
      .then((prefs) => {
        if (restored.current) return;
        restored.current = true;
        setFormat(prefs.defaultImageFormat === "avif" && !limits.avifSupported ? "webp" : prefs.defaultImageFormat);
        setQuality(prefs.defaultQuality);
        if (prefs.defaultMaxWidth) setMaxWidth(String(prefs.defaultMaxWidth));
      })
      .catch(() => {
        /* Defaults stay built-in when storage is unavailable. */
      });
  }, [limits.avifSupported]);

  /* Files staged by the Asset Analyzer land here without being selected again. */
  useEffect(() => {
    const staged = takeStagedFiles();
    if (staged.length > 0) addItem(staged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Re-optimize a previous result straight from history: /app/images?from=<artifactId> */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const from = params.get("from");
    if (!from) return;
    let cancelled = false;
    fetch(artifactUrl(from, false), { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) {
          // A storage failure is not the same as an expired result. The API's
          // wording for it is fixed and safe to show.
          const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
          throw new Error(
            res.status === 503 && body?.error?.code === "storage_unavailable" && body.error.message
              ? body.error.message
              : "That stored result is no longer available.",
          );
        }
        const blob = await res.blob();
        const name =
          res.headers.get("x-optiweb-original-name") ??
          /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ??
          "stored-image";
        const file = new File([blob], name, { type: blob.type || "image/png" });
        if (!cancelled) addItem([file]);
      })
      .catch((error: Error) => push({ tone: "danger", title: "Could not load stored result", description: error.message }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addItem = useCallback(
    (files: File[]) => {
      setFailure(null);
      setItems((current) => {
        const room = limits.maxFiles - current.length;
        if (room <= 0) {
          push({
            tone: "warn",
            title: `Batch limit reached (${limits.maxFiles} files)`,
            description: "Remove a file or process this batch first.",
          });
          return current;
        }
        const accepted = files.slice(0, room);
        const rejected = files.slice(room);
        const tooBig = accepted.filter((file) => file.size > limits.maxFileMb * 1024 * 1024);
        const fitting = accepted.filter((file) => file.size <= limits.maxFileMb * 1024 * 1024);
        // The batch as a whole has a size limit too. Files are taken in order while they fit.
        const batchLimit = limits.maxBatchMb ? limits.maxBatchMb * 1024 * 1024 : Number.POSITIVE_INFINITY;
        let batchBytes = current.reduce((sum, item) => sum + item.file.size, 0);
        const allowed: File[] = [];
        const overBatch: File[] = [];
        for (const file of fitting) {
          if (batchBytes + file.size > batchLimit) overBatch.push(file);
          else {
            allowed.push(file);
            batchBytes += file.size;
          }
        }
        if (overBatch.length > 0) {
          push({
            tone: "warn",
            title: `${overBatch.length} file${overBatch.length === 1 ? "" : "s"} not added`,
            description: `A batch holds at most ${limits.maxBatchMb} MB in total.`,
          });
        }

        if (rejected.length > 0) {
          push({
            tone: "warn",
            title: `${rejected.length} file${rejected.length === 1 ? "" : "s"} not added`,
            description: `A batch holds at most ${limits.maxFiles} files.`,
          });
        }
        if (tooBig.length > 0) {
          push({
            tone: "warn",
            title: `${tooBig.length} file${tooBig.length === 1 ? "" : "s"} over the size limit`,
            description: `Each file must be ${limits.maxFileMb} MB or smaller.`,
          });
        }
        return [
          ...current,
          ...allowed.map((file) => ({
            key: crypto.randomUUID(),
            file,
            status: "ready" as ItemStatus,
            preview: URL.createObjectURL(file),
          })),
        ];
      });
    },
    [limits.maxBatchMb, limits.maxFileMb, limits.maxFiles, push],
  );

  const removeItem = (key: string) => {
    setItems((current) => {
      const target = current.find((item) => item.key === key);
      if (target) releaseItem(target);
      return current.filter((item) => item.key !== key);
    });
  };

  const reset = () => {
    for (const item of items) releaseItem(item);
    setItems([]);
    setResponse(null);
    setFailure(null);
    runnerRef.current?.reset();
    setDirect(null);
  };

  const pending = items.filter((item) => item.status === "ready" || item.status === "failed");
  const parseDimension = (value: string): number | null => {
    if (!value.trim()) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(clamp(parsed, 16, 8000));
  };

  /** What a background job reports is mirrored into the queue, file by file. */
  const applyDirectState = (state: DirectRunState) => {
    setDirect(state);
    const byKey = new Map(state.files.map((file) => [file.key, file]));
    const statusOf = (file: DirectFile): ItemStatus =>
      file.phase === "pending" || file.phase === "uploading" ? "uploading" : file.phase === "queued" || file.phase === "processing" ? "processing" : file.phase === "upload_failed" ? "failed" : "processing";

    if (state.phase === "finished" && state.job && isTerminal(state.job)) {
      const job = state.job;
      const data = responseFromJob(job);
      const elapsed = performance.now() - directStartedRef.current;
      // Results are matched to queue entries by the upload ID each entry was given.
      const resultByKey = new Map<string, Partial<Item>>();
      for (const file of state.files) {
        const item = job.items.find((candidate) => candidate.id === file.uploadId);
        const result = item ? data.results.find((candidate) => candidate.id === (item.artifactId ?? item.id)) : undefined;
        if (result) resultByKey.set(file.key, { ...settleResult(data, result), localOutput: null });
        // A cancelled file was not processed: it goes back to the queue as it was.
        else resultByKey.set(file.key, { status: "ready", error: undefined });
      }
      setItems((current) => current.map((item) => (resultByKey.has(item.key) ? { ...item, ...resultByKey.get(item.key) } : item)));
      setBusy(false);
      onJobSettled?.();
      if (data.results.length > 0) {
        setResponse(data);
        const outcome = describeImageOutcome(data);
        push({ tone: outcome.toast.tone, title: outcome.toast.title, description: outcome.toast.description ?? `${formatBytes(data.totals.savedBytes)} saved · finished in ${formatDuration(elapsed)}` });
      } else {
        push({ tone: "neutral", title: "Job cancelled", description: "No file was converted. Your queue is unchanged." });
      }
      return;
    }
    if (state.phase === "error") {
      setItems((current) => current.map((item) => (byKey.has(item.key) ? { ...item, status: "ready", error: undefined } : item)));
      setFailure(state.error ?? { message: "The job could not be completed." });
      setBusy(false);
      onJobSettled?.();
      return;
    }
    setItems((current) =>
      current.map((item) => {
        const file = byKey.get(item.key);
        return file ? { ...item, status: statusOf(file), error: file.phase === "upload_failed" ? file.error ?? "The upload failed." : undefined } : item;
      }),
    );
  };

  /** Direct mode: the files go straight to object storage and a background job converts them. */
  const runDirect = async () => {
    if (pending.length === 0 || busy) return;
    setBusy(true);
    setFailure(null);
    setResponse(null);
    const width = parseDimension(maxWidth);
    const height = parseDimension(maxHeight);
    const settings: ImageOptimizeSettings = { format, quality, policy, maxWidth: width, maxHeight: height };
    const entries = pending.map((item) => ({ key: item.key, file: item.file }));
    directStartedRef.current = performance.now();
    runnerRef.current?.dispose();
    const runner = new DirectJobRunner({ api: transport.api, upload: transport.upload, onChange: applyDirectState });
    runnerRef.current = runner;
    await runner.start(entries, settings);
  };

  const run = async () => {
    if (directMode) return runDirect();
    if (pending.length === 0 || busy) return;
    setBusy(true);
    setFailure(null);
    setResponse(null);
    // Track which queue entries are in this run so previously completed items
    // are never clobbered by shifted response indices.
    const pendingKeys = pending.map((item) => item.key);
    setItems((current) =>
      current.map((item) =>
        pendingKeys.includes(item.key) ? { ...item, status: "processing", error: undefined } : item,
      ),
    );

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const form = new FormData();
    for (const item of pending) form.append("files", item.file, item.file.name);
    form.append("format", format);
    form.append("policy", policy);
    form.append("quality", String(quality));
    const width = parseDimension(maxWidth);
    const height = parseDimension(maxHeight);
    if (width) form.append("maxWidth", String(width));
    if (height) form.append("maxHeight", String(height));

    try {
      const started = performance.now();
      const data = await api.post<ImageOptimizeResponse>("/api/v1/images/optimize", form, {
        signal: controller.signal,
      });
      const elapsed = performance.now() - started;

      // A file that could not be stored arrives inside the response. Decode
      // each one once, here, and keep it in this tab. A payload that cannot be
      // decoded is removed from the response too, so the summary and the file
      // list never disagree about what can be downloaded.
      const localByResult = new Map<string, LocalOutput>();
      const unreadable = new Set<string>();
      for (const result of data.results) {
        const inline = inlineOutputOf(data, result);
        if (!inline) continue;
        const local = createLocalOutput(inline, result.outputFilename);
        if (local) localByResult.set(result.id, local);
        else unreadable.add(result.id);
      }
      const shown: ImageOptimizeResponse =
        unreadable.size === 0
          ? data
          : { ...data, results: data.results.map((result) => (unreadable.has(result.id) ? { ...result, inlineOutput: null } : result)) };

      setResponse(shown);
      // Whether a file has a download, and where it comes from, is decided
      // once, from this response.
      const settledByKey = new Map<string, Partial<Item>>();
      shown.results.forEach((result, index) => {
        const key = pendingKeys[index];
        if (key) settledByKey.set(key, { ...settleResult(shown, result), localOutput: localByResult.get(result.id) ?? null });
      });
      setItems((current) =>
        current.map((item) => {
          const settled = settledByKey.get(item.key);
          return settled ? { ...item, ...settled } : item;
        }),
      );

      // The toast states the same outcome as the results panel: stored,
      // converted but not stored, or conversion failed.
      const outcome = describeImageOutcome(shown);
      push({
        tone: outcome.toast.tone,
        title: outcome.toast.title,
        description:
          outcome.toast.description ??
          `${formatBytes(shown.totals.savedBytes)} saved · finished in ${formatDuration(elapsed)}`,
      });
    } catch (error) {
      const cancelled = error instanceof ApiClientError && error.code === "cancelled";
      setItems((current) => current.map((item) => (item.status === "processing" ? { ...item, status: "ready" } : item)));
      if (cancelled) {
        push({ tone: "neutral", title: "Cancelled", description: "Nothing was written. Your queue is unchanged." });
        return;
      }
      const message = error instanceof ApiClientError ? error.message : "The batch could not be processed.";
      const hint = error instanceof ApiClientError ? error.hint : undefined;
      setFailure({ message, hint });
      push({ tone: "danger", title: "Batch failed", description: message });
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (directMode) {
      void runnerRef.current?.cancel();
      return;
    }
    abortRef.current?.abort();
  };

  const directFiles = useMemo(() => new Map((direct?.files ?? []).map((file) => [file.key, file])), [direct]);
  const stalledCount = direct?.files.filter((file) => file.phase === "upload_failed").length ?? 0;
  /** Files of the finished job whose failure was temporary, so that running them again can help. */
  const retryableCount = directMode && direct?.phase === "finished" ? (direct.job?.items.filter((item) => item.retryable).length ?? 0) : 0;
  const retryFailed = () => {
    setBusy(true);
    setFailure(null);
    setResponse(null);
    directStartedRef.current = performance.now();
    void runnerRef.current?.retryFailed();
  };

  const completed = useMemo(() => items.filter((item) => item.status === "completed" && item.result), [items]);
  const failed = useMemo(() => items.filter((item) => item.status === "failed"), [items]);
  const showResults = Boolean(response) && (completed.length > 0 || failed.length > 0);

  /** `ids` are stored output files only; the review panel never passes anything else. */
  const downloadAll = async (ids: string[]) => {
    if (ids.length === 0) return;
    if (directMode) {
      // Large bundles are handed to the browser's own download, which writes
      // to disk as the bytes arrive instead of holding the archive in memory.
      triggerDownload(`/api/v1/artifacts/zip?ids=${ids.join(",")}&name=optiweb-images`, "optiweb-images.zip");
      push({ tone: "ok", title: "Download started", description: `${ids.length} optimized file${ids.length === 1 ? "" : "s"} in one ZIP.` });
      return;
    }
    setZipping(true);
    try {
      await downloadZip(ids, "optiweb-images");
      push({ tone: "ok", title: "Bundle ready", description: `${ids.length} optimized file${ids.length === 1 ? "" : "s"} downloaded.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The bundle could not be created.";
      push({ tone: "danger", title: "Bundle failed", description: message });
    } finally {
      setZipping(false);
    }
  };

  /** Bundles unstored files held in this tab. Nothing is requested from the server. */
  const downloadLocal = async (outputs: LocalOutput[]) => {
    if (outputs.length === 0) return;
    setZipping(true);
    try {
      const bundle = await zipLocalOutputs(outputs);
      triggerDownload(URL.createObjectURL(bundle), "optiweb-images.zip");
      push({ tone: "ok", title: "Bundle ready", description: `${outputs.length} optimized file${outputs.length === 1 ? "" : "s"} downloaded from this tab.` });
    } catch {
      push({ tone: "danger", title: "Bundle failed", description: "The files could not be bundled. Download them one at a time instead." });
    } finally {
      setZipping(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* ---------------------------------------------------------- select */}
      <Panel aria-labelledby="select-panel">
        <PanelHeader
          id="select-panel"
          title="1 · Select images"
          description={
            directMode
              ? "Files are uploaded straight to private storage and converted by a background job. Each file is checked on arrival and decoded before any conversion."
              : "Files are decoded on the server before any conversion, so an unreadable upload is rejected immediately."
          }
          meta={<FormatTag>max {limits.maxFiles} files</FormatTag>}
        />
        <FileDropzone
          accept="image/jpeg,image/png,image/webp,image/avif,image/gif,image/tiff"
          multiple
          disabled={busy}
          onFiles={addItem}
          selectedCount={items.length}
          title="Drop images here"
          description="JPEG, PNG, WebP, AVIF, GIF or TIFF. Vector SVG is analysed, not rasterised."
          constraints={`${limits.maxFileMb} MB per file · ${limits.maxFiles} files per batch${limits.maxBatchMb ? ` · ${limits.maxBatchMb} MB per batch` : ""} · ${(limits.maxDecodedPixels / 1_000_000).toFixed(0)} MP decoded-pixel cap · aspect ratio always preserved`}
        />
        {items.length > 0 ? (
          <div className="mt-4 overflow-hidden rounded-md border border-line">
            <ul>
              {items.map((item) => (
                <FileRow
                  key={item.key}
                  name={item.file.name}
                  status={item.status}
                  thumbnail={item.preview}
                  detail={`${formatBytes(item.file.size)} · ${(item.file.type || "unknown type").replace("image/", "")}${busy && directFiles.has(item.key) ? ` · ${directDetail(directFiles.get(item.key)!)}` : ""}`}
                  saved={
                    item.result?.status === "completed"
                      ? { bytes: item.result.savedBytes, percent: item.result.savingsPercent }
                      : null
                  }
                  error={item.error ?? null}
                  onRemove={busy ? undefined : () => removeItem(item.key)}
                />
              ))}
            </ul>
            <p className="border-t border-line bg-surface-sunken/50 px-3 py-2 font-mono text-2xs text-muted" data-testid="batch-total">
              {items.length} file{items.length === 1 ? "" : "s"} · {formatBytes(items.reduce((sum, item) => sum + item.file.size, 0))}
              {limits.maxBatchMb ? ` of ${limits.maxBatchMb} MB per batch` : ""}
            </p>
          </div>
        ) : null}
      </Panel>

      {/* ------------------------------------------------------- configure */}
      <Panel aria-labelledby="configure-panel">
        <PanelHeader
          id="configure-panel"
          title="2 · Configure output"
          description="Defaults are read from Settings. Only options the pipeline implements are offered."
          actions={
            <Button variant="ghost" size="sm" onClick={() => setShowAdvanced((value) => !value)} aria-expanded={showAdvanced}>
              <SlidersHorizontal className="size-3.5" aria-hidden />
              {showAdvanced ? "Hide" : "Show"} dimensions
            </Button>
          }
        />
        <div className="grid gap-5 lg:grid-cols-2">
          <Field
            label="Strategy"
            htmlFor="policy"
            hint="No-regression keeps the original bytes when every candidate is larger. Best-effort still reports negative savings if the smallest candidate grew."
          >
            <SegmentedControl
              name="policy"
              label="Optimization strategy"
              value={policy}
              onChange={setPolicy}
              options={[
                { value: "single", label: "Single" },
                { value: "best-effort", label: "Best-effort" },
                { value: "no-regression", label: "No-regression" },
              ]}
            />
          </Field>
          <Field label="Output format" htmlFor="format" hint="Used as the preferred format. Best-effort also tries AVIF/JPEG when safe.">
            <SegmentedControl
              name="format"
              label="Output format"
              value={format}
              onChange={setFormat}
              options={FORMATS.filter((entry) => entry.value !== "avif" || limits.avifSupported).map((entry) => ({ value: entry.value, label: entry.label }))}
            />
          </Field>
          {format === "png" ? (
            <div className="rounded-md border border-line bg-surface-sunken px-3 py-3 text-sm text-ink-soft" role="status">
              PNG uses lossless compression; the quality slider does not apply to this format.
            </div>
          ) : (
            <Field
              label="Quality"
              htmlFor="quality"
              hint={`Quality applies to lossy JPEG, WebP and AVIF outputs. PNG stays lossless. Current: ${quality}.`}
              trailing={<span className="font-mono text-xs text-muted tnum">{quality}</span>}
            >
              <input
                id="quality"
                type="range"
                min={30}
                max={100}
                step={1}
                value={quality}
                onChange={(event) => setQuality(Number(event.target.value))}
                className="mt-2 h-1.5 w-full accent-accent"
                aria-valuetext={`${quality} of 100`}
              />
            </Field>
          )}
        </div>
        {showAdvanced ? (
          <div className="animate-fade-up mt-5 grid gap-4 border-t border-line pt-5 sm:grid-cols-2">
            <Field label="Max width (px)" htmlFor="maxWidth" hint="Optional. Larger images are scaled down, never enlarged.">
              <Input
                id="maxWidth"
                inputMode="numeric"
                placeholder="e.g. 1920"
                value={maxWidth}
                onChange={(event) => setMaxWidth(event.target.value.replace(/[^\d]/g, ""))}
              />
            </Field>
            <Field label="Max height (px)" htmlFor="maxHeight" hint="Leave empty to constrain width only.">
              <Input
                id="maxHeight"
                inputMode="numeric"
                placeholder="e.g. 1080"
                value={maxHeight}
                onChange={(event) => setMaxHeight(event.target.value.replace(/[^\d]/g, ""))}
              />
            </Field>
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button variant="primary" size="lg" onClick={run} loading={busy} disabled={pending.length === 0}>
            {busy ? "Processing…" : `Optimize ${pending.length || ""} file${pending.length === 1 ? "" : "s"}`.trim()}
          </Button>
          {items.length > 0 && !busy ? (
            <Button variant="ghost" size="lg" onClick={reset} leading={<Trash2 className="size-3.5" aria-hidden />}>
              Clear queue
            </Button>
          ) : null}
          {busy ? (
            <>
              <Button variant="secondary" size="lg" onClick={cancel}>
                Cancel
              </Button>
              <div className="min-w-[180px] flex-1">
                <ProgressIndicator label={directMode && direct ? directSummary(direct) : `Encoding ${pending.length} file${pending.length === 1 ? "" : "s"} on the server…`} />
              </div>
            </>
          ) : null}
          {retryableCount > 0 && !busy ? (
            <Button variant="secondary" size="lg" onClick={retryFailed}>
              Retry {retryableCount} failed file{retryableCount === 1 ? "" : "s"}
            </Button>
          ) : null}
        </div>

        {directMode && direct?.phase === "upload_stalled" ? (
          <div className="mt-4">
            <ErrorState
              title="Some uploads did not finish"
              message={`${stalledCount} file${stalledCount === 1 ? "" : "s"} could not be uploaded. The other files are safe in storage.`}
              hint="Check your connection and retry, or continue with the files that arrived."
              action={
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => void runnerRef.current?.retryUploads()}>
                    Retry uploads
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void runnerRef.current?.skipFailedUploads()}>
                    Continue without them
                  </Button>
                </div>
              }
            />
          </div>
        ) : null}

        {failure ? (
          <div className="mt-4">
            <ErrorState
              title="Batch rejected"
              message={failure.message}
              hint={failure.hint ?? "Your queue is unchanged — adjust the settings and run it again."}
              action={
                <Button variant="secondary" size="sm" onClick={run}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : null}
      </Panel>

      {/* ---------------------------------------------------------- review */}
      {showResults && response ? (
        <ImageReview response={response} items={items} zipping={zipping} onDownloadAll={downloadAll} onDownloadLocal={downloadLocal} onReset={reset} />
      ) : null}

      {items.length === 0 && !busy ? (
        <Panel as="aside">
          <div className="flex gap-3.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-md border border-line bg-surface-sunken text-accent">
              <Info className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">What happens to your files</h2>
              {directMode ? (
                <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-muted">
                  Your browser uploads each file straight to private storage; it is not sent through the
                  application server. A background job then converts the files one at a time, and the page
                  shows how many are done. The job keeps running if you close this tab, and its results
                  appear in History. Only this browser session can download them. Source files are deleted{" "}
                  {limits.sourceTtlHours ?? 24} hours after the job, converted files after{" "}
                  {Math.round((limits.artifactTtlHours ?? 720) / 24)} days. If an output is larger than its
                  source, the result is reported as a negative saving rather than discarded.
                </p>
              ) : (
                <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-muted">
                  Uploads are decoded in memory, re-encoded with sharp, and stored as an artifact tied to this
                  browser session so you can download them again. Artifacts expire after the configured retention period (30 days by default). Conversion
                  happens on the server; if the output is larger than the source, the result is reported as a
                  negative saving rather than discarded. If the output cannot be stored, the results say so and
                  the converted files are sent back with the results instead: you can save them from this tab,
                  but they are not kept on the server and do not appear in History.
                </p>
              )}
              <ButtonLink href="/app/assets" variant="ghost" size="sm" className="mt-2 px-0">
                Not sure which file to optimize? Analyze it first
              </ButtonLink>
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
