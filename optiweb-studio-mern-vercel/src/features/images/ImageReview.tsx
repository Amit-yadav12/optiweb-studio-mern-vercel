import { Download, Package, RotateCcw } from "lucide-react";
import { Button, ButtonLink, buttonClass } from "@/components/ui/Button";
import { Notice, StatusBadge } from "@/components/ui/Feedback";
import { DefinitionRow, Panel, PanelHeader, StatStrip, TableShell, Td, Th } from "@/components/ui/Layout";
import { SavingsChart } from "@/components/charts/SavingsChart";
import { CompareSlider } from "@/features/images/CompareSlider";
import { describeImageOutcome, type ImageOutcome } from "@/features/images/outcome";
import { artifactUrl } from "@/lib/api-client";
import { formatBytes, formatDimensions, formatDuration, formatSavingsPercent } from "@/lib/format";
import type { ImageOptimizeResponse, ImageResult } from "@/types/domain";

export type ItemStatus = "ready" | "processing" | "completed" | "failed";

/** One queued upload and, once processed, its result. */
export type OptimizerItem = {
  key: string;
  file: File;
  status: ItemStatus;
  preview: string;
  result?: ImageResult;
  /** ID of the stored output file. Set by `settleResult`; null or absent when the output was not stored. */
  artifactId?: string | null;
  error?: string;
};

/**
 * States the outcome of a run in one place: converted and stored, converted
 * but not stored, or conversion failed.
 */
export function ImageOutcomeNotice({ outcome }: { outcome: ImageOutcome }) {
  const failure = outcome.storageFailure;
  // A storage failure is the subject of the notice only when files were
  // converted. When nothing was converted it is a secondary remark.
  const storageIsTheProblem = outcome.kind === "converted_not_stored";
  return (
    <Notice
      tone={outcome.tone}
      title={outcome.title}
      hint={storageIsTheProblem ? failure?.hint : null}
      code={storageIsTheProblem ? failure?.category : null}
      action={
        outcome.historyJobId && outcome.kind === "stored" ? (
          <ButtonLink href={`/app/history/${outcome.historyJobId}`} variant="secondary" size="sm">
            Open this job in History
          </ButtonLink>
        ) : undefined
      }
    >
      <p>{outcome.message}</p>
      {storageIsTheProblem && failure ? <p className="mt-1">Reason: {failure.message}</p> : null}
      {outcome.kind === "conversion_failed" && failure ? (
        <p className="mt-1 text-xs text-ink-soft">This attempt was not recorded in History either. {failure.message}</p>
      ) : null}
    </Notice>
  );
}

/**
 * Results of the optimization queue. The banner, badges and totals describe
 * the latest run (`response`). Each file's download exists only if that file's
 * output was stored (`item.artifactId`).
 */
export function ImageReview({
  response,
  items,
  zipping,
  onDownloadAll,
  onReset,
}: {
  response: ImageOptimizeResponse;
  items: OptimizerItem[];
  zipping: boolean;
  /** Receives the IDs of the stored output files. */
  onDownloadAll: (artifactIds: string[]) => void;
  onReset: () => void;
}) {
  const outcome = describeImageOutcome(response);
  const completed = items.filter((item) => item.status === "completed" && item.result);
  const failed = items.filter((item) => item.status === "failed");
  const artifactIdOf = (item: OptimizerItem): string | null => item.artifactId ?? null;
  const storedIds = completed.map(artifactIdOf).filter((id): id is string => id !== null);

  return (
    <section aria-labelledby="review-panel" className="animate-fade-up flex flex-col gap-6">
      <Panel aria-labelledby="review-panel">
        <PanelHeader
          id="review-panel"
          title="3 · Review results"
          description="Every value below was measured from the produced buffers."
          meta={
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusBadge tone={outcome.conversion.tone}>{outcome.conversion.label}</StatusBadge>
              <StatusBadge tone={outcome.storage.tone}>{outcome.storage.label}</StatusBadge>
            </span>
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {storedIds.length > 1 ? (
                <Button variant="secondary" size="sm" onClick={() => onDownloadAll(storedIds)} loading={zipping} leading={<Package className="size-3.5" aria-hidden />}>
                  Download all (ZIP)
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={onReset} leading={<RotateCcw className="size-3.5" aria-hidden />}>
                Optimize another file
              </Button>
            </div>
          }
        />
        <div className="mb-4">
          <ImageOutcomeNotice outcome={outcome} />
        </div>
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
                {completed.map((item) => {
                  const artifactId = artifactIdOf(item);
                  return (
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
                        {artifactId ? (
                          <a
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent-hover hover:underline"
                            href={artifactUrl(artifactId)}
                            download
                          >
                            <Download className="size-3.5" aria-hidden />
                            Save
                          </a>
                        ) : (
                          <span className="text-xs text-muted">Not stored</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </TableShell>
          </Panel>

          <div className="grid gap-4 xl:grid-cols-2">
            {completed.map((item) => (
              <ResultCard key={item.key} item={item} artifactId={artifactIdOf(item)} />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** `artifactId` is the stored output file, or null when this result was not stored. */
function ResultCard({ item, artifactId }: { item: OptimizerItem; artifactId: string | null }) {
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
        {artifactId && sameAspect ? (
          <CompareSlider
            beforeSrc={item.preview}
            afterSrc={artifactUrl(artifactId, false)}
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
              {artifactId ? (
                <img
                  src={artifactUrl(artifactId, false)}
                  alt={`Optimized ${item.file.name}`}
                  className="max-h-40 w-auto max-w-full object-contain"
                />
              ) : (
                <p className="px-3 text-center text-xs text-muted">No preview. The converted file was not stored.</p>
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
        {artifactId ? (
          <>
            <a className={buttonClass({ variant: "primary", size: "sm" })} href={artifactUrl(artifactId)} download>
              <Download className="size-3.5" aria-hidden />
              Download
            </a>
            <ButtonLink href={`/app/assets?inspect=${artifactId}`} variant="ghost" size="sm">
              Inspect
            </ButtonLink>
          </>
        ) : (
          <p className="text-xs text-muted">Not stored, so there is no file to download.</p>
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
