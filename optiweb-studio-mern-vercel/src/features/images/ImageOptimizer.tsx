import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImageDown, Info, ShieldCheck, SlidersHorizontal, Trash2 } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { ErrorState, Notice, ProgressIndicator, useToast } from "@/components/ui/Feedback";
import { FileDropzone } from "@/components/ui/FileDropzone";
import { FileRow } from "@/components/ui/FileRow";
import { Field, Input, SegmentedControl } from "@/components/ui/Form";
import { Panel, PanelHeader } from "@/components/ui/Layout";
import { takeStagedFiles } from "@/features/assets/transfer";
import { ImageReview } from "@/features/images/ImageReview";
import { createImageEngine, type EngineJob, type ImageEngine } from "@/features/images/engine/engine";
import { formatName, inspectFile } from "@/features/images/engine/inspect";
import {
  DIMENSION_MAX,
  DIMENSION_MIN,
  FORMAT_LABEL,
  QUALITY_MAX,
  QUALITY_MIN,
  clampDimension,
  clampQuality,
  jobTimeoutMs,
  planCandidates,
  resolveEngineLimits,
  selectOutcome,
  targetSize,
  type EngineLimits,
} from "@/features/images/engine/plan";
import type { FormatChoice, Inspection, JobFailure, JobResult, OptimizeSettings, SkippedCandidate, Strategy } from "@/features/images/engine/types";
import { STATUS_LABEL, finalOf, isPending, settingsKey, summarize, type ItemOutcome, type OptimizerItem } from "@/features/images/model";
import { saveBlob, zipFiles } from "@/lib/download";
import { formatBytes, formatDimensions } from "@/lib/format";
import { usePreferences } from "@/lib/preferences";
import { recordActivity } from "@/lib/session-activity";

const FORMATS: Array<{ value: FormatChoice; label: string }> = [
  { value: "webp", label: "WebP" },
  { value: "avif", label: "AVIF" },
  { value: "jpeg", label: "JPEG" },
  { value: "png", label: "PNG" },
  { value: "original", label: "Keep format" },
];

const STRATEGY_HINT: Record<Strategy, string> = {
  single: "Writes the chosen format. If a result is larger than its original, the result says so and you can keep the original instead.",
  "best-effort": "Encodes each file as WebP, AVIF and (when it has no transparency) JPEG, and keeps the smallest of them.",
  "no-regression": "As best-effort, but when no result is smaller than the original, the original file is kept unchanged. A result is never larger.",
};

/** What a browser reports about the device. Missing values fall back to mid-range limits. */
function deviceLimits(): EngineLimits {
  const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } });
  return resolveEngineLimits({
    deviceMemory: nav?.deviceMemory ?? null,
    cores: nav?.hardwareConcurrency ?? null,
    mobile: nav?.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(nav?.userAgent ?? ""),
  });
}

const megapixels = (pixels: number) => `${Math.round(pixels / 1_000_000)} MP`;

let nextId = 0;
const newId = () => `file-${(nextId += 1)}`;

/** Runs `task` over `values`, a few at a time. */
async function inBatches<T>(values: readonly T[], size: number, task: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(size, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await task(values[index]);
    }
  });
  await Promise.all(workers);
}

export type ImageOptimizerProps = {
  /** Tests supply an engine, limits and an inspector. The app uses the real ones. */
  engine?: ImageEngine;
  limits?: EngineLimits;
  inspect?: (file: Blob, name: string, limits: Pick<EngineLimits, "maxSourcePixels">) => Promise<Inspection>;
};

export function ImageOptimizer({ engine: suppliedEngine, limits: suppliedLimits, inspect = inspectFile }: ImageOptimizerProps = {}) {
  const { push } = useToast();
  const preferences = usePreferences();
  const limits = useMemo(() => suppliedLimits ?? deviceLimits(), [suppliedLimits]);

  const [items, setItems] = useState<OptimizerItem[]>([]);
  const [format, setFormat] = useState<FormatChoice>(preferences.defaultImageFormat);
  const [strategy, setStrategy] = useState<Strategy>(preferences.defaultStrategy);
  const [quality, setQuality] = useState<number>(preferences.defaultQuality);
  const [maxWidth, setMaxWidth] = useState<string>(preferences.defaultMaxWidth ? String(preferences.defaultMaxWidth) : "");
  const [maxHeight, setMaxHeight] = useState<string>("");
  const [showAdvanced, setShowAdvanced] = useState<boolean>(Boolean(preferences.defaultMaxWidth));
  const [busy, setBusy] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);

  const engineRef = useRef<ImageEngine | null>(suppliedEngine ?? null);
  const itemsRef = useRef<OptimizerItem[]>(items);
  itemsRef.current = items;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Stops any work in progress and frees the workers' memory. Results are
      // Blobs owned by this component's state, so they go with it.
      engineRef.current?.dispose();
      if (!suppliedEngine) engineRef.current = null;
    };
  }, [suppliedEngine]);

  const patch = useCallback((id: string, change: Partial<OptimizerItem> | ((item: OptimizerItem) => Partial<OptimizerItem>)) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...(typeof change === "function" ? change(item) : change) } : item)));
  }, []);

  /* --------------------------------- queue --------------------------------- */

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const existing = new Set(itemsRef.current.map((item) => `${item.file.name}|${item.file.size}|${item.file.lastModified}`));
      const fresh: OptimizerItem[] = [];
      let duplicates = 0;
      let overLimit = 0;
      for (const file of files) {
        const key = `${file.name}|${file.size}|${file.lastModified}`;
        if (existing.has(key)) {
          duplicates += 1;
          continue;
        }
        if (itemsRef.current.length + fresh.length >= limits.maxFiles) {
          overLimit += 1;
          continue;
        }
        existing.add(key);
        fresh.push({ id: newId(), file, status: "checking", source: null, problem: null, stage: null, outcome: null });
      }
      const left = [duplicates > 0 ? `${duplicates} already in the queue` : null, overLimit > 0 ? `${overLimit} beyond ${limits.maxFiles} files in one queue` : null].filter(Boolean);
      setNotice(left.length > 0 ? { title: `${duplicates + overLimit} file${duplicates + overLimit === 1 ? "" : "s"} not added`, message: `Left out: ${left.join(", ")}.` } : null);
      if (fresh.length === 0) return;
      setItems((current) => [...current, ...fresh]);
      // Each file is checked from its own bytes before it can be processed.
      void inBatches(fresh, 4, async (item) => {
        let inspection: Inspection;
        try {
          inspection = await inspect(item.file, item.file.name, limits);
        } catch {
          inspection = { ok: false, code: "unreadable", message: "The browser could not read this file.", hint: "Select it again." };
        }
        if (!mountedRef.current) return;
        patch(item.id, inspection.ok ? { status: "ready", source: inspection.source } : { status: "rejected", problem: { message: inspection.message, hint: inspection.hint } });
      });
    },
    [inspect, limits, patch],
  );

  // Files handed over by the Asset Analyzer. They are passed in memory.
  useEffect(() => {
    const staged = takeStagedFiles();
    if (staged.length > 0) addFiles(staged);
  }, [addFiles]);

  const settings: OptimizeSettings = useMemo(
    () => ({
      format,
      strategy,
      quality: clampQuality(quality),
      maxWidth: clampDimension(maxWidth === "" ? null : Number(maxWidth)),
      maxHeight: clampDimension(maxHeight === "" ? null : Number(maxHeight)),
    }),
    [format, strategy, quality, maxWidth, maxHeight],
  );
  const key = settingsKey(settings);
  const pending = items.filter((item) => isPending(item, key));
  const checking = items.filter((item) => item.status === "checking").length;
  const inWork = items.filter((item) => item.status === "queued" || item.status === "processing");
  const summary = useMemo(() => summarize(items), [items]);
  const usesAvif = strategy !== "single" || format === "avif";
  const usesQuality = strategy !== "single" || (format !== "png" && !(format === "original" && pending.every((item) => item.source?.format === "png") && pending.length > 0));

  /* ---------------------------------- run ---------------------------------- */

  const run = useCallback(() => {
    if (busy) return;
    const runSettings = settings;
    const runKey = settingsKey(runSettings);
    const targets = itemsRef.current.filter((item) => isPending(item, runKey));
    if (targets.length === 0) return;

    engineRef.current ??= createImageEngine({ limits });
    const engine = engineRef.current;
    const started = new Map<string, number>();
    const skippedBy = new Map<string, SkippedCandidate[]>();
    const jobs: EngineJob[] = [];
    const refused = new Map<string, { message: string; hint: string }>();

    for (const item of targets) {
      const source = item.source;
      if (!source) continue;
      const output = targetSize(source.width, source.height, runSettings.maxWidth, runSettings.maxHeight);
      const plan = planCandidates(runSettings, source, output, limits);
      if (!plan.ok) {
        refused.set(item.id, { message: plan.message, hint: plan.hint });
        continue;
      }
      skippedBy.set(item.id, plan.skipped);
      jobs.push({
        request: { id: item.id, file: item.file, source, maxWidth: runSettings.maxWidth, maxHeight: runSettings.maxHeight, candidates: plan.candidates, avifMaxPixels: limits.avifMaxPixels },
        pixels: source.width * source.height,
        timeoutMs: jobTimeoutMs(source.width * source.height, output.width * output.height, plan.candidates.map((candidate) => candidate.format)),
      });
    }

    const queued = new Set(jobs.map((job) => job.request.id));
    setItems((current) =>
      current.map((item) => {
        const problem = refused.get(item.id);
        if (problem) return { ...item, status: "failed", problem, stage: null, outcome: null };
        if (queued.has(item.id)) return { ...item, status: "queued", problem: null, stage: null, outcome: null };
        return item;
      }),
    );
    if (jobs.length === 0) return;

    setBusy(true);
    let remaining = jobs.length;
    // The state each job ended in, kept here so the summary of this run does
    // not depend on when React applies the last update.
    const ended = new Map<string, OptimizerItem>();
    const byId = new Map(targets.map((item) => [item.id, item]));
    const end = (id: string, change: Partial<OptimizerItem>) => {
      const item = byId.get(id);
      if (item) ended.set(id, { ...item, ...change });
      patch(id, change);
      remaining -= 1;
      if (remaining > 0 || !mountedRef.current) return;
      setBusy(false);
      const done = summarize([...ended.values()]);
      if (done.done > 0) recordActivity("images", { items: done.done, inputBytes: done.inputBytes, outputBytes: done.outputBytes });
      const unfinished = done.failed + done.cancelled;
      push({
        tone: unfinished > 0 || done.grew > 0 ? "warn" : "ok",
        title: done.done > 0 ? `${done.done} file${done.done === 1 ? "" : "s"} processed in this tab` : "No file was processed",
        description:
          done.done > 0
            ? `${formatBytes(done.inputBytes)} in, ${formatBytes(done.outputBytes)} out${unfinished > 0 ? ` · ${unfinished} not finished` : ""}${done.keptOriginal > 0 ? ` · ${done.keptOriginal} original${done.keptOriginal === 1 ? "" : "s"} kept` : ""}`
            : `${unfinished} file${unfinished === 1 ? "" : "s"} did not finish. The reasons are listed in the queue.`,
      });
    };

    engine.submit(jobs, {
      stage: (id, stage, detail) => {
        if (!started.has(id)) started.set(id, performance.now());
        patch(id, { status: "processing", stage: stage === "encoding" && detail ? `encoding ${detail}` : stage });
      },
      done: (id, result: JobResult) => {
        const selection = selectOutcome(runSettings.strategy, byId.get(id)?.file.size ?? 0, result.candidates);
        if (selection === null) {
          const problems = result.candidates.map((candidate) => candidate.problem).filter((problem): problem is string => Boolean(problem));
          end(id, { status: "failed", stage: null, outcome: null, problem: { message: problems[0] ?? "No output could be encoded.", hint: "Choose another output format and run it again." } });
          return;
        }
        const outcome: ItemOutcome = { result, skipped: skippedBy.get(id) ?? [], selection, preferOriginal: false, durationMs: Math.round(performance.now() - (started.get(id) ?? performance.now())), settingsKey: runKey };
        end(id, { status: "done", stage: null, problem: null, outcome });
      },
      failed: (id, failure: JobFailure) => {
        end(id, failure.code === "cancelled" ? { status: "cancelled", stage: null, problem: null, outcome: null } : { status: "failed", stage: null, outcome: null, problem: { message: failure.message, hint: failure.hint } });
      },
    });
  }, [busy, limits, patch, push, settings]);

  const cancel = () => engineRef.current?.cancelAll();

  const reset = () => {
    engineRef.current?.cancelAll();
    setItems([]);
    setNotice(null);
    setBusy(false);
  };

  const remove = (id: string) => setItems((current) => current.filter((item) => item.id !== id));

  const preferOriginal = (id: string, value: boolean) => patch(id, (item) => (item.outcome ? { outcome: { ...item.outcome, preferOriginal: value } } : {}));

  const downloadAll = async () => {
    const files = itemsRef.current.map(finalOf).filter((file): file is NonNullable<typeof file> => file !== null);
    if (files.length === 0 || zipping) return;
    setZipping(true);
    try {
      const archive = await zipFiles(files.map((file) => ({ name: file.filename, blob: file.blob })));
      saveBlob(archive, "unikit-images.zip");
      push({ tone: "ok", title: "ZIP created in this tab", description: `${files.length} file${files.length === 1 ? "" : "s"} · ${formatBytes(archive.size)}` });
    } catch {
      push({ tone: "danger", title: "The ZIP could not be created", description: "The tab may be short of memory. Download the files one by one instead." });
    } finally {
      setZipping(false);
    }
  };

  /* --------------------------------- render -------------------------------- */

  const finished = items.filter((item) => item.status === "done" || item.status === "failed" || item.status === "cancelled").length;
  const current = inWork.find((item) => item.status === "processing");
  const progress = busy
    ? `${items.filter((item) => item.status === "done").length} done, ${inWork.length} to go${current ? ` · ${current.stage ?? "working"}: ${current.file.name}` : ""}`
    : null;
  const stale = items.filter((item) => item.status === "done" && item.outcome?.settingsKey !== key).length;

  return (
    <div className="flex flex-col gap-6">
      {/* ---------------------------------------------------------- select */}
      <Panel labelledBy="select-panel">
        <PanelHeader
          id="select-panel"
          title="1 · Select images"
          description="The files are opened by this browser tab. They are not uploaded: there is no server that could receive them."
        />
        <FileDropzone
          accept="image/jpeg,image/png,image/webp,image/avif,image/gif,image/bmp,image/tiff,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.avif,.gif,.bmp,.tif,.tiff,.heic,.heif"
          multiple
          disabled={busy}
          onFiles={addFiles}
          icon={<ImageDown className="size-4.5" aria-hidden />}
          title="Drop images here"
          description="JPEG, PNG, WebP, AVIF, GIF or BMP. TIFF and HEIC work in browsers that can decode them."
          selectedCount={items.length}
          constraints={`Each file is checked from its contents before it is decoded. An image may have up to ${megapixels(limits.maxSourcePixels)} on this device; animations and SVG are not converted.`}
        />
        {notice ? (
          <div className="mt-4">
            <Notice tone="warn" title={notice.title}>
              <p>{notice.message}</p>
            </Notice>
          </div>
        ) : null}
        {items.length > 0 ? (
          <div className="mt-4 border border-line">
            <ul aria-label="Selected files" data-testid="queue">
              {items.map((item) => {
                const status = STATUS_LABEL[item.status];
                const final = finalOf(item);
                const facts = item.source
                  ? `${formatName(item.source.format)} · ${formatBytes(item.file.size)} · ${formatDimensions(item.source.width, item.source.height)}`
                  : formatBytes(item.file.size);
                const note =
                  item.status === "processing"
                    ? item.stage
                    : final
                      ? final.isOriginal
                        ? "original kept"
                        : `${final.formatLabel} ${formatBytes(final.bytes)}, ${final.savedBytes === 0 ? "same size" : `${Math.abs(final.savingsPercent)}% ${final.grew ? "larger" : "smaller"}`}`
                      : item.source?.nameMismatch;
                return (
                  <FileRow
                    key={item.id}
                    name={item.file.name}
                    status={status.label}
                    tone={status.tone}
                    detail={facts}
                    note={note}
                    error={item.problem?.message}
                    hint={item.problem?.hint}
                    onRemove={busy ? undefined : () => remove(item.id)}
                  />
                );
              })}
            </ul>
            <p className="border-t border-line bg-surface-sunken/50 px-3 py-2 font-mono text-2xs text-muted" data-testid="queue-total">
              {items.length} file{items.length === 1 ? "" : "s"} · {formatBytes(items.reduce((sum, item) => sum + item.file.size, 0))}
              {checking > 0 ? ` · checking ${checking}` : ""}
              {summary.rejected > 0 ? ` · ${summary.rejected} not accepted` : ""}
            </p>
          </div>
        ) : null}
      </Panel>

      {/* ------------------------------------------------------- configure */}
      <Panel labelledBy="configure-panel">
        <PanelHeader
          id="configure-panel"
          title="2 · Configure output"
          description="Defaults come from Settings. Every option here is carried out by this browser."
          actions={
            <Button variant="ghost" size="sm" onClick={() => setShowAdvanced((value) => !value)} aria-expanded={showAdvanced}>
              <SlidersHorizontal className="size-3.5" aria-hidden />
              {showAdvanced ? "Hide size limits" : "Size limits"}
            </Button>
          }
        />
        <div className="grid gap-5 lg:grid-cols-2">
          <Field label="Strategy" hint={STRATEGY_HINT[strategy]}>
            <SegmentedControl
              name="strategy"
              label="Optimization strategy"
              value={strategy}
              onChange={setStrategy}
              options={[
                { value: "single", label: "Single" },
                { value: "best-effort", label: "Best-effort" },
                { value: "no-regression", label: "No-regression" },
              ]}
            />
          </Field>
          {strategy === "single" ? (
            <Field
              label="Output format"
              hint={
                format === "original"
                  ? "Each file keeps its format. A browser can write JPEG, PNG, WebP and AVIF; a file in another format needs one of those chosen."
                  : format === "jpeg"
                    ? "JPEG has no transparency. Transparent areas become white."
                    : format === "png"
                      ? "PNG is lossless. It suits flat graphics; a photograph usually grows."
                      : `${FORMAT_LABEL[format]} keeps transparency.`
              }
            >
              <SegmentedControl name="format" label="Output format" value={format} onChange={setFormat} options={FORMATS} />
            </Field>
          ) : (
            <div className="rounded-md border border-line bg-surface-sunken px-3 py-3 text-sm text-ink-soft" role="status">
              The format is chosen per file: WebP, AVIF or JPEG, whichever is smallest. AVIF is left out for an output above {megapixels(limits.avifCandidateMaxPixels)}.
            </div>
          )}
          {usesQuality ? (
            <Field
              label="Quality"
              htmlFor="quality"
              hint="The number is given to the encoder as it is. Scales differ between formats: AVIF at 60 looks about like JPEG at 80."
              trailing={<span className="font-mono text-xs text-muted tnum">{quality}</span>}
            >
              <input
                id="quality"
                type="range"
                min={QUALITY_MIN}
                max={QUALITY_MAX}
                step={1}
                value={quality}
                onChange={(event) => setQuality(Number(event.target.value))}
                className="mt-2 h-1.5 w-full accent-accent"
                aria-valuetext={`${quality} of 100`}
              />
            </Field>
          ) : (
            <div className="rounded-md border border-line bg-surface-sunken px-3 py-3 text-sm text-ink-soft" role="status">
              PNG uses lossless compression; the quality slider does not apply to this format.
            </div>
          )}
          {usesAvif ? (
            <p className="self-end text-xs leading-relaxed text-muted" data-testid="avif-note">
              No browser can write AVIF from a canvas, so a WebAssembly codec does it. It is a 3.3 MB file (about 1 MB as it travels, compressed) served by this site, downloaded the first time AVIF is needed. Your image is not part of that request.
            </p>
          ) : null}
        </div>
        {showAdvanced ? (
          <div className="animate-fade-up mt-5 grid gap-4 border-t border-line pt-5 sm:grid-cols-2">
            <Field label="Max width (px)" htmlFor="maxWidth" hint={`Optional, ${DIMENSION_MIN}–${DIMENSION_MAX.toLocaleString("en-US")}. Larger images are scaled down, never enlarged.`}>
              <Input id="maxWidth" inputMode="numeric" placeholder="e.g. 1920" value={maxWidth} onChange={(event) => setMaxWidth(event.target.value.replace(/[^\d]/g, "").slice(0, 5))} />
            </Field>
            <Field label="Max height (px)" htmlFor="maxHeight" hint="Leave empty to limit the width only. Proportions are always kept.">
              <Input id="maxHeight" inputMode="numeric" placeholder="e.g. 1080" value={maxHeight} onChange={(event) => setMaxHeight(event.target.value.replace(/[^\d]/g, "").slice(0, 5))} />
            </Field>
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button variant="primary" size="lg" onClick={run} loading={busy} disabled={pending.length === 0 || checking > 0}>
            {busy ? "Processing…" : pending.length > 0 ? `Optimize ${pending.length} file${pending.length === 1 ? "" : "s"}` : "Optimize"}
          </Button>
          {busy ? (
            <Button variant="secondary" size="lg" onClick={cancel}>
              Cancel
            </Button>
          ) : items.length > 0 ? (
            <Button variant="ghost" size="lg" onClick={reset} leading={<Trash2 className="size-3.5" aria-hidden />}>
              Clear all
            </Button>
          ) : null}
          {!busy && stale > 0 ? <p className="text-xs text-muted">The settings changed: {stale} result{stale === 1 ? "" : "s"} will be made again.</p> : null}
          {!busy && items.length > 0 && pending.length === 0 && checking === 0 && summary.done > 0 ? <p className="text-xs text-muted">Every file has a result for these settings.</p> : null}
        </div>
        {busy && progress ? (
          <div className="mt-4" data-testid="progress">
            <ProgressIndicator label={progress} />
          </div>
        ) : null}
        {!busy && finished > 0 && summary.done === 0 && summary.failed > 0 ? (
          <div className="mt-4">
            <ErrorState title="No file could be processed" message="Each file's reason is listed in the queue above." hint="Your queue is unchanged. Adjust the settings and run it again." />
          </div>
        ) : null}
      </Panel>

      {/* ---------------------------------------------------------- review */}
      {summary.done > 0 || (!busy && (summary.failed > 0 || summary.cancelled > 0)) ? (
        <ImageReview items={items} summary={summary} zipping={zipping} busy={busy} onDownloadAll={downloadAll} onPreferOriginal={preferOriginal} onReset={reset} />
      ) : null}

      <Panel as="aside">
        <div className="flex gap-3.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-md border border-line bg-surface-sunken text-accent">
            <ShieldCheck className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">What happens to your files</h2>
            <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-muted">
              Your browser reads each file, decodes it, resizes it on a canvas and encodes the result, in a Web Worker of this tab. The file is never
              sent anywhere: the server behind this site has no endpoint that accepts files. The results are held in this tab's memory until you clear
              them, leave the page or close the tab; downloads and the ZIP are made here too.
            </p>
            <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-muted">
              <Info className="mr-1 inline size-3 align-[-1px]" aria-hidden />
              Converted files carry no metadata: EXIF, GPS location and colour profiles are not copied, a photo's rotation is applied to the pixels, and
              colours are converted to sRGB at 8 bits per channel.
            </p>
            <ButtonLink href="/app/assets" variant="ghost" size="sm" className="mt-2 px-0">
              Not sure which file to optimize? Analyze it first
            </ButtonLink>
          </div>
        </div>
      </Panel>
    </div>
  );
}
