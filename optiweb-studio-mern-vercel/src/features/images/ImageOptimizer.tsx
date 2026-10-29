import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Info, Package, RotateCcw, SlidersHorizontal, Trash2 } from "lucide-react";
import { Button, ButtonLink, buttonClass } from "@/components/ui/Button";
import { ErrorState, ProgressIndicator, StatusBadge, useToast} from "@/components/ui/Feedback";
import { statusToneFor } from "@/lib/status";
import { Field, Input, SegmentedControl } from "@/components/ui/Form";
import { DefinitionRow, FormatTag, Panel, PanelHeader, StatStrip, TableShell, Td, Th } from "@/components/ui/Layout";
import { FileDropzone } from "@/components/ui/FileDropzone";
import { FileRow } from "@/components/ui/FileRow";
import { SavingsChart } from "@/components/charts/SavingsChart";
import { CompareSlider } from "@/features/images/CompareSlider";
import { takeStagedFile } from "@/features/assets/transfer";
import { ApiClientError, api, artifactUrl, downloadZip } from "@/lib/api-client";
import { clamp, formatBytes, formatDimensions, formatDuration, formatSavingsPercent } from "@/lib/format";
import type { ImageOptimizeResponse, ImageResult, Preferences } from "@/types/domain";

type ItemStatus = "ready" | "processing" | "completed" | "failed";

type Item = {
  key: string;
  file: File;
  status: ItemStatus;
  preview: string;
  result?: ImageResult;
  error?: string;
};

export type OptimizerLimits = {
  maxFileMb: number;
  maxFiles: number;
  maxDecodedPixels: number;
};

const FORMATS = [
  { value: "webp", label: "WebP" },
  { value: "avif", label: "AVIF" },
  { value: "jpeg", label: "JPEG" },
  { value: "png", label: "PNG" },
  { value: "original", label: "Keep" },
] as const;

export function ImageOptimizer({ limits }: { limits: OptimizerLimits }) {
  const { push } = useToast();
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
      for (const item of itemsRef.current) URL.revokeObjectURL(item.preview);
    };
  }, []);

  /* Saved defaults come from the real preferences row for this session. */
  useEffect(() => {
    api
      .get<Preferences>("/api/v1/preferences")
      .then((prefs) => {
        if (restored.current) return;
        restored.current = true;
        setFormat(prefs.defaultImageFormat);
        setQuality(prefs.defaultQuality);
        if (prefs.defaultMaxWidth) setMaxWidth(String(prefs.defaultMaxWidth));
      })
      .catch(() => {
        /* Defaults stay built-in when storage is unavailable. */
      });
  }, []);

  /* A file staged by the Asset Analyzer lands here without a re-upload. */
  useEffect(() => {
    const staged = takeStagedFile();
    if (staged) addItem([staged]);
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
        if (!res.ok) throw new Error("That stored result is no longer available.");
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
        const allowed = accepted.filter((file) => file.size <= limits.maxFileMb * 1024 * 1024);

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
    [limits.maxFileMb, limits.maxFiles, push],
  );

  const removeItem = (key: string) => {
    setItems((current) => {
      const target = current.find((item) => item.key === key);
      if (target) URL.revokeObjectURL(target.preview);
      return current.filter((item) => item.key !== key);
    });
  };

  const reset = () => {
    for (const item of items) URL.revokeObjectURL(item.preview);
    setItems([]);
    setResponse(null);
    setFailure(null);
  };

  const pending = items.filter((item) => item.status === "ready" || item.status === "failed");
  const parseDimension = (value: string): number | null => {
    if (!value.trim()) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(clamp(parsed, 16, 8000));
  };

  const run = async () => {
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

      setResponse(data);
      const resultByKey = new Map<string, ImageResult>();
      data.results.forEach((result, index) => {
        const key = pendingKeys[index];
        if (key) resultByKey.set(key, result);
      });
      setItems((current) =>
        current.map((item) => {
          const result = resultByKey.get(item.key);
          if (!result) return item;
          return result.status === "completed"
            ? { ...item, status: "completed", result, error: undefined }
            : { ...item, status: "failed", result, error: result.message ?? "Processing failed." };
        }),
      );

      const okCount = data.results.filter((result) => result.status === "completed").length;
      push({
        tone: data.status === "failed" ? "danger" : data.status === "partial" ? "warn" : "ok",
        title:
          data.status === "failed"
            ? "No file could be converted"
            : data.status === "partial"
              ? `${okCount} of ${data.results.length} files converted`
              : `${okCount} file${okCount === 1 ? "" : "s"} converted`,
        description: `${formatBytes(data.totals.savedBytes)} saved · finished in ${formatDuration(elapsed)}`,
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
    abortRef.current?.abort();
  };

  const completed = useMemo(() => items.filter((item) => item.status === "completed" && item.result), [items]);
  const failed = useMemo(() => items.filter((item) => item.status === "failed"), [items]);
  const showResults = Boolean(response) && (completed.length > 0 || failed.length > 0);

  const downloadAll = async () => {
    const ids = completed.map((item) => item.result?.id).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
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

  return (
    <div className="flex flex-col gap-6">
      {/* ---------------------------------------------------------- select */}
      <Panel aria-labelledby="select-panel">
        <PanelHeader
          id="select-panel"
          title="1 · Select images"
          description="Files are decoded on the server before any conversion, so an unreadable upload is rejected immediately."
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
          constraints={`${limits.maxFileMb} MB per file · ${limits.maxFiles} files per batch · ${(limits.maxDecodedPixels / 1_000_000).toFixed(0)} MP decoded-pixel cap · aspect ratio always preserved`}
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
                  detail={`${formatBytes(item.file.size)} · ${(item.file.type || "unknown type").replace("image/", "")}`}
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
              options={FORMATS.map((entry) => ({ value: entry.value, label: entry.label }))}
            />
          </Field>
          <Field
            label="Quality"
            htmlFor="quality"
            hint={`Higher keeps more detail. Current setting: ${quality} — measured savings update after conversion.`}
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
                <ProgressIndicator label={`Encoding ${pending.length} file${pending.length === 1 ? "" : "s"} on the server…`} />
              </div>
            </>
          ) : null}
        </div>

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
        <section aria-labelledby="review-panel" className="animate-fade-up flex flex-col gap-6">
          <Panel aria-labelledby="review-panel">
            <PanelHeader
              id="review-panel"
              title="3 · Review results"
              description="Every value below was measured from the produced buffers."
              meta={<StatusBadge tone={statusToneFor(response.status)}>{response.status}</StatusBadge>}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  {completed.length > 1 && response.persisted ? (
                    <Button variant="secondary" size="sm" onClick={downloadAll} loading={zipping} leading={<Package className="size-3.5" aria-hidden />}>
                      Download all (ZIP)
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={reset} leading={<RotateCcw className="size-3.5" aria-hidden />}>
                    Optimize another file
                  </Button>
                </div>
              }
            />
            {response.persisted ? null : (
              <div className="mb-4">
                <ErrorState
                  title="History storage is offline"
                  message="Results were produced, but they are not stored, so downloads and history are unavailable for this run."
                  hint="Configure `MONGODB_URI` in your environment, verify `/api/v1/health`, then process the files again."
                />
              </div>
            )}
            <StatStrip
              items={[
                { label: "Input", value: formatBytes(response.totals.inputBytes), hint: `${response.results.length} files submitted` },
                { label: "Output", value: formatBytes(response.totals.outputBytes), hint: `${completed.length} converted` },
                {
                  label: "Saved",
                  value: formatBytes(response.totals.savedBytes),
                  hint: formatSavingsPercent(response.totals.savingsPercent),
                },
                { label: "Failed", value: String(failed.length), hint: failed.length > 0 ? "details below" : "nothing rejected" },
              ]}
            />
            {completed.length > 0 ? (
              <div className="mt-5 border border-line">
                <p className="border-b border-line px-4 py-2.5 text-2xs font-medium tracking-[0.1em] text-muted uppercase">
                  Weight comparison
                </p>
                <div className="p-4">
                  <SavingsChart
                    rows={completed.map((item) => ({
                      label: shorten(item.file.name),
                      input: item.result!.inputBytes,
                      output: item.result!.outputBytes,
                    }))}
                    max={Math.max(...completed.map((item) => item.result!.inputBytes))}
                  />
                </div>
              </div>
            ) : null}
          </Panel>

          {failed.length > 0 ? (
            <Panel>
              <PanelHeader title="Rejected files" description="These uploads were not converted. The rest of the batch is unaffected." />
              <ul className="flex flex-col gap-2">
                {failed.map((item) => (
                  <li key={item.key} className="border border-danger-border bg-danger-soft px-3 py-2.5">
                    <p className="truncate text-sm text-ink">{item.file.name}</p>
                    <p className="mt-0.5 text-xs text-danger/85">{item.error}</p>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {completed.length > 0 ? (
            <>
              <Panel padded={false}>
                <div className="px-4 pt-4 sm:px-5">
                  <PanelHeader title="Batch table" description="Aligned figures for scanning a large batch." />
                </div>
                <TableShell minWidth={760}>
                  <thead>
                    <tr>
                      <Th>File</Th>
                      <Th numeric>Before</Th>
                      <Th numeric>After</Th>
                      <Th numeric>Saved</Th>
                      <Th numeric>Dimensions</Th>
                      <Th>Format</Th>
                      <Th numeric>Time</Th>
                      <Th numeric>Download</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {completed.map((item) => (
                      <tr key={item.key}>
                        <Td mono>
                          <span className="block max-w-[13rem] truncate" title={item.file.name}>
                            {item.file.name}
                          </span>
                        </Td>
                        <Td numeric>{formatBytes(item.result!.inputBytes)}</Td>
                        <Td numeric>{formatBytes(item.result!.outputBytes)}</Td>
                        <Td numeric>
                          <span className={item.result!.savedBytes >= 0 ? "text-ok" : "text-danger"}>
                            {formatBytes(item.result!.savedBytes)}
                          </span>
                          <span className="ml-1.5 text-muted">{formatSavingsPercent(item.result!.savingsPercent)}</span>
                        </Td>
                        <Td numeric>{formatDimensions(item.result!.outputWidth, item.result!.outputHeight)}</Td>
                        <Td mono>{item.result!.outputFormat}</Td>
                        <Td numeric>{formatDuration(item.result!.durationMs)}</Td>
                        <Td numeric>
                          {response.persisted ? (
                            <a
                              className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent-hover hover:underline"
                              href={artifactUrl(item.result!.id)}
                              download
                            >
                              <Download className="size-3.5" aria-hidden />
                              Save
                            </a>
                          ) : (
                            <span className="text-xs text-muted" title="Downloads require configured MongoDB persistence">Unavailable</span>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
              </Panel>

              <div className="grid gap-4 xl:grid-cols-2">
                {completed.map((item) => (
                  <ResultCard key={item.key} item={item} persisted={response.persisted} />
                ))}
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {items.length === 0 && !busy ? (
        <Panel as="aside">
          <div className="flex gap-3.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-md border border-line bg-surface-sunken text-accent">
              <Info className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">What happens to your files</h2>
              <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-muted">
                Uploads are decoded in memory, re-encoded with sharp, and stored as an artifact tied to this
                browser session so you can download them again. Artifacts expire after the configured retention period (30 days by default). Conversion
                happens on the server; if the output is larger than the source, the result is reported as a
                negative saving rather than discarded.
              </p>
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

function ResultCard({ item, persisted }: { item: Item; persisted: boolean }) {
  const result = item.result!;
  const sameAspect =
    result.inputWidth &&
    result.inputHeight &&
    result.outputWidth &&
    result.outputHeight &&
    Math.abs(result.inputWidth / result.inputHeight - result.outputWidth / result.outputHeight) < 0.01;

  return (
    <Panel as="article" aria-label={`Result for ${item.file.name}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink" title={item.file.name}>
            {item.file.name}
          </p>
          <p className="mt-0.5 truncate font-mono text-2xs text-muted" title={result.outputFilename}>
            {result.outputFilename}
          </p>
        </div>
        <StatusBadge tone={result.savedBytes >= 0 ? "ok" : "danger"}>
          {formatSavingsPercent(result.savingsPercent)}
        </StatusBadge>
      </div>

      <div className="mt-4">
        {persisted && sameAspect ? (
          <CompareSlider
            beforeSrc={item.preview}
            afterSrc={artifactUrl(result.id, false)}
            alt={item.file.name}
            width={result.outputWidth ?? 1}
            height={result.outputHeight ?? 1}
          />
        ) : (
          <div className="checker grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line">
            <figure className="grid place-items-center p-2">
              <img src={item.preview} alt={`Original ${item.file.name}`} className="max-h-40 w-auto max-w-full object-contain" />
              <figcaption className="mt-1.5 font-mono text-2xs text-muted">original</figcaption>
            </figure>
            <figure className="grid place-items-center border-l border-line p-2">
              {persisted ? (
                <img
                  src={artifactUrl(result.id, false)}
                  alt={`Optimized ${item.file.name}`}
                  className="max-h-40 w-auto max-w-full object-contain"
                />
              ) : (
                <p className="px-3 text-center text-xs text-muted">Preview unavailable because output storage is offline.</p>
              )}
              <figcaption className="mt-1.5 font-mono text-2xs text-muted">optimized</figcaption>
            </figure>
          </div>
        )}
      </div>

      <dl className="mt-4">
        <DefinitionRow label="Original size" value={formatBytes(result.inputBytes)} />
        <DefinitionRow label="Optimized size" value={formatBytes(result.outputBytes)} />
        <DefinitionRow
          label="Saved"
          value={
            <span className={result.savedBytes >= 0 ? "text-ok" : "text-danger"}>
              {formatBytes(result.savedBytes)} ({formatSavingsPercent(result.savingsPercent)})
            </span>
          }
        />
        <DefinitionRow
          label="Dimensions"
          value={`${formatDimensions(result.inputWidth, result.inputHeight)} → ${formatDimensions(result.outputWidth, result.outputHeight)}`}
        />
        <DefinitionRow label="Output format" value={`${result.outputFormat} · ${formatDuration(result.durationMs)}`} />
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        {persisted ? (
          <>
            <a className={buttonClass({ variant: "primary", size: "sm" })} href={artifactUrl(result.id)} download>
              <Download className="size-3.5" aria-hidden />
              Download
            </a>
            <ButtonLink href={`/app/assets?inspect=${result.id}`} variant="ghost" size="sm">
              Inspect
            </ButtonLink>
          </>
        ) : (
          <Button variant="primary" size="sm" disabled title="Configure MongoDB persistence to retrieve stored artifacts">
            <Download className="size-3.5" aria-hidden />
            Download unavailable
          </Button>
        )}
      </div>
    </Panel>
  );
}

function shorten(name: string, max = 16): string {
  if (name.length <= max) return name;
  const ext = name.slice(name.lastIndexOf("."));
  return `${name.slice(0, max - ext.length - 1)}…${ext}`;
}
