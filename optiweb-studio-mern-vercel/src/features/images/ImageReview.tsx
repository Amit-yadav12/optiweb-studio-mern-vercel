import { useState } from "react";
import { Download, Package, RotateCcw, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Notice, StatusBadge } from "@/components/ui/Feedback";
import { DefinitionRow, FormatTag, Panel, PanelHeader, StatStrip, TableShell, Td, Th } from "@/components/ui/Layout";
import { SavingsChart } from "@/components/charts/SavingsChart";
import { CompareSlider } from "@/features/images/CompareSlider";
import { FORMAT_LABEL } from "@/features/images/engine/plan";
import { chosenCandidate, convertedIsNotSmaller, finalOf, type BatchSummary, type FinalFile, type OptimizerItem } from "@/features/images/model";
import { saveBlob } from "@/lib/download";
import { useObjectUrl } from "@/lib/useObjectUrl";
import { formatBytes, formatDimensions, formatDuration, formatSavingsPercent } from "@/lib/format";

/** How many result cards, each with two decoded previews, are shown before "Show more". */
const CARDS_PER_PAGE = 6;

export function ImageReview({
  items,
  summary,
  zipping,
  busy,
  onDownloadAll,
  onPreferOriginal,
  onReset,
}: {
  items: OptimizerItem[];
  summary: BatchSummary;
  zipping: boolean;
  busy: boolean;
  onDownloadAll: () => void;
  onPreferOriginal: (id: string, value: boolean) => void;
  onReset: () => void;
}) {
  const [cards, setCards] = useState(CARDS_PER_PAGE);
  const finished = items.map((item) => ({ item, final: finalOf(item) })).filter((entry): entry is { item: OptimizerItem; final: FinalFile } => entry.final !== null);
  const unfinished = items.filter((item) => item.status === "failed" || item.status === "cancelled");
  const larger = finished.filter(({ final }) => final.grew);

  return (
    <section className="animate-fade-up flex flex-col gap-6" aria-labelledby="review-panel" data-testid="review">
      <Panel>
        <PanelHeader
          id="review-panel"
          title="3 · Review results"
          description="Sizes are the real byte counts of your file and of the file this browser produced."
          actions={
            <>
              {finished.length > 0 ? (
                <Button variant="secondary" size="sm" onClick={onDownloadAll} loading={zipping} disabled={busy} leading={<Package className="size-3.5" aria-hidden />}>
                  Download all (ZIP)
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={onReset} leading={<RotateCcw className="size-3.5" aria-hidden />}>
                Start over
              </Button>
            </>
          }
        />
        <StatStrip
          items={[
            { label: "Input", value: formatBytes(summary.inputBytes), hint: `${summary.done} file${summary.done === 1 ? "" : "s"} with a result` },
            { label: "Output", value: formatBytes(summary.outputBytes), hint: `${summary.converted} converted${summary.keptOriginal > 0 ? ` · ${summary.keptOriginal} original kept` : ""}` },
            {
              label: "Saved",
              value: summary.done > 0 ? `${formatBytes(summary.savedBytes)} (${formatSavingsPercent(summary.savingsPercent)})` : "—",
              hint: summary.savedBytes < 0 ? "the output is larger" : "measured, not estimated",
            },
            { label: "Not finished", value: String(summary.failed + summary.cancelled), hint: summary.failed + summary.cancelled > 0 ? "details below" : "nothing failed" },
          ]}
        />

        {larger.length > 0 ? (
          <div className="mt-4">
            <Notice tone="warn" title={`${larger.length} result${larger.length === 1 ? " is" : "s are"} larger than the original`}>
              <p>
                Re-encoding does not always help: a file that is already well compressed, or a flat graphic stored as PNG, can grow. For each such file
                you can keep the original instead. The <span className="font-medium">No-regression</span> strategy does that for you.
              </p>
            </Notice>
          </div>
        ) : null}

        {finished.length > 0 ? (
          <div className="mt-5">
            <SavingsChart rows={finished.slice(0, 12).map(({ item, final }) => ({ label: shorten(item.file.name), input: item.file.size, output: final.bytes }))} />
            {finished.length > 12 ? <p className="mt-2 text-2xs text-muted">The chart shows the first 12 files. The table lists all {finished.length}.</p> : null}
          </div>
        ) : null}
      </Panel>

      {unfinished.length > 0 ? (
        <Panel>
          <PanelHeader title="Files without a result" description="These files were not converted. The other files are not affected." />
          <ul className="flex flex-col divide-y divide-line border border-line" data-testid="unfinished">
            {unfinished.map((item) => (
              <li key={item.id} className="px-3 py-2.5">
                <p className="text-sm text-ink">
                  <span className="font-medium">{item.file.name}</span>
                  <span className="ml-2 font-mono text-2xs text-muted">{item.status === "cancelled" ? "cancelled" : "failed"}</span>
                </p>
                <p className="mt-0.5 text-xs text-danger">{item.status === "cancelled" ? "Stopped before it finished." : item.problem?.message}</p>
                {item.problem?.hint ? <p className="mt-0.5 text-xs text-muted">{item.problem.hint}</p> : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {finished.length > 0 ? (
        <Panel padded={false}>
          <div className="px-4 pt-4 sm:px-5">
            <PanelHeader title="Batch table" description="One row per file. Download a single file, or keep the original where the result is larger." />
          </div>
          <TableShell minWidth={860}>
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
            <tbody data-testid="results">
              {finished.map(({ item, final }) => (
                <tr key={item.id} data-result={final.isOriginal ? "original" : final.grew ? "larger" : "smaller"}>
                  <Td>
                    <span className="block max-w-[14rem] truncate text-ink" title={item.file.name}>
                      {item.file.name}
                    </span>
                    <span className="block max-w-[14rem] truncate font-mono text-2xs text-muted" title={final.filename}>
                      {final.isOriginal ? "original kept" : final.filename}
                    </span>
                  </Td>
                  <Td numeric>{formatBytes(item.file.size)}</Td>
                  <Td numeric>{formatBytes(final.bytes)}</Td>
                  <Td numeric>
                    <span className={final.grew ? "text-danger" : final.savedBytes > 0 ? "text-ok" : "text-ink-soft"}>{final.isOriginal ? "0%" : formatSavingsPercent(final.savingsPercent)}</span>
                  </Td>
                  <Td numeric>{formatDimensions(final.width, final.height)}</Td>
                  <Td>
                    <FormatTag>{final.formatLabel}</FormatTag>
                  </Td>
                  <Td numeric>{formatDuration(item.outcome?.durationMs ?? 0)}</Td>
                  <Td numeric>
                    <span className="inline-flex items-center justify-end gap-1.5">
                      {convertedIsNotSmaller(item) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onPreferOriginal(item.id, !item.outcome?.preferOriginal)}
                          leading={<Undo2 className="size-3.5" aria-hidden />}
                          aria-label={item.outcome?.preferOriginal ? `Use the converted file for ${item.file.name}` : `Keep the original for ${item.file.name}`}
                        >
                          {item.outcome?.preferOriginal ? "Use converted" : "Keep original"}
                        </Button>
                      ) : null}
                      <Button variant="secondary" size="sm" onClick={() => saveBlob(final.blob, final.filename)} leading={<Download className="size-3.5" aria-hidden />} aria-label={`Download ${final.filename}`}>
                        Save
                      </Button>
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </Panel>
      ) : null}

      {finished.length > 0 ? (
        <div>
          <div className="grid gap-5 xl:grid-cols-2">
            {finished.slice(0, cards).map(({ item, final }) => (
              <ResultCard key={item.id} item={item} final={final} />
            ))}
          </div>
          {finished.length > cards ? (
            <div className="mt-4 flex items-center gap-3">
              <Button variant="secondary" size="sm" onClick={() => setCards((value) => value + CARDS_PER_PAGE)}>
                Show {Math.min(CARDS_PER_PAGE, finished.length - cards)} more previews
              </Button>
              <p className="text-xs text-muted">
                Previews are decoded images held in memory, so they are shown a few at a time. {cards} of {finished.length} shown.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ResultCard({ item, final }: { item: OptimizerItem; final: FinalFile }) {
  const outcome = item.outcome;
  const source = item.source;
  // Both previews point at Blobs in this tab. The URLs are released when the card leaves the page.
  const beforeUrl = useObjectUrl(item.file);
  const afterUrl = useObjectUrl(final.isOriginal ? null : final.blob);
  if (!outcome || !source) return null;
  const chosen = chosenCandidate(outcome);
  const sameShape = !final.isOriginal && Math.abs(source.width / source.height - final.width / final.height) < 0.01;
  const candidates = [
    ...outcome.result.candidates.map((candidate, index) => ({
      key: `c${index}`,
      label: FORMAT_LABEL[candidate.format],
      note: candidate.problem ? `${candidate.note} — ${candidate.problem}` : candidate.note,
      bytes: candidate.blob?.size ?? null,
      chosen: candidate === chosen && !final.isOriginal,
      detail: candidate.blob ? `${formatDuration(candidate.ms)} · ${candidate.encoder === "wasm" ? "WebAssembly codec" : "browser encoder"}` : null,
    })),
    ...outcome.skipped.map((skipped, index) => ({ key: `s${index}`, label: FORMAT_LABEL[skipped.format], note: skipped.note, bytes: null as number | null, chosen: false, detail: null as string | null })),
  ];

  return (
    <Panel as="article" className="min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-ink" title={item.file.name}>
            {item.file.name}
          </h3>
          <p className="mt-0.5 truncate font-mono text-2xs text-muted" title={final.filename}>
            {final.isOriginal ? "original kept" : final.filename}
          </p>
        </div>
        <StatusBadge tone={final.isOriginal ? "neutral" : final.grew ? "danger" : "ok"}>{final.isOriginal ? "original" : formatSavingsPercent(final.savingsPercent)}</StatusBadge>
      </div>

      <div className="mt-4">
        {final.isOriginal ? (
          <div className="rounded-md border border-line bg-surface-sunken px-3 py-3 text-xs leading-relaxed text-ink-soft" role="status">
            {final.originalReason} The download is your file, unchanged.
          </div>
        ) : beforeUrl && afterUrl && sameShape ? (
          <CompareSlider beforeSrc={beforeUrl} afterSrc={afterUrl} alt={item.file.name} width={final.width} height={final.height} />
        ) : beforeUrl && afterUrl ? (
          <div className="checker grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line">
            <figure className="grid place-items-center p-2">
              <img src={beforeUrl} alt={`Original ${item.file.name}`} className="max-h-40 w-auto max-w-full object-contain" />
              <figcaption className="mt-1.5 font-mono text-2xs text-muted">original</figcaption>
            </figure>
            <figure className="grid place-items-center border-l border-line p-2">
              <img src={afterUrl} alt={`Optimized ${item.file.name}`} className="max-h-40 w-auto max-w-full object-contain" />
              <figcaption className="mt-1.5 font-mono text-2xs text-muted">optimized</figcaption>
            </figure>
          </div>
        ) : null}
      </div>

      <dl className="mt-4">
        <DefinitionRow label="Original size" value={formatBytes(item.file.size)} />
        <DefinitionRow label={final.isOriginal ? "Offered file" : "Optimized size"} value={formatBytes(final.bytes)} />
        <DefinitionRow
          label="Saved"
          value={<span className={final.grew ? "text-danger" : final.savedBytes > 0 ? "text-ok" : ""}>{final.isOriginal ? "0 B (0%)" : `${formatBytes(final.savedBytes)} (${formatSavingsPercent(final.savingsPercent)})`}</span>}
        />
        <DefinitionRow label="Dimensions" value={`${formatDimensions(source.width, source.height)} to ${formatDimensions(final.width, final.height)}`} />
        <DefinitionRow label="Format" value={`${source.format.toUpperCase()} to ${final.formatLabel}`} />
      </dl>

      {outcome.result.flattened && final.format === "jpeg" ? <p className="mt-3 text-xs text-warn">This image had transparent areas. JPEG cannot store them, so they are white in the result.</p> : null}
      {source.metadata.gps && !final.isOriginal ? <p className="mt-3 text-xs text-muted">The original carries a GPS location in its metadata. The converted file does not.</p> : null}

      {candidates.length > 1 || final.isOriginal ? (
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-2xs font-medium tracking-[0.1em] text-muted uppercase">Formats compared</p>
          <ul className="mt-2 flex flex-col gap-1">
            {candidates.map((candidate) => (
              <li key={candidate.key} className="flex items-baseline justify-between gap-3 text-xs">
                <span className={candidate.chosen ? "font-medium text-ink" : "text-ink-soft"}>
                  {candidate.note}
                  {candidate.chosen ? " · chosen" : ""}
                </span>
                <span className="shrink-0 font-mono text-2xs text-muted tnum">
                  {candidate.bytes !== null ? formatBytes(candidate.bytes) : "—"}
                  {candidate.detail ? ` · ${candidate.detail}` : ""}
                </span>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-3 text-xs">
              <span className={final.isOriginal ? "font-medium text-ink" : "text-ink-soft"}>original file{final.isOriginal ? " · kept" : ""}</span>
              <span className="shrink-0 font-mono text-2xs text-muted tnum">{formatBytes(item.file.size)}</span>
            </li>
          </ul>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => saveBlob(final.blob, final.filename)} leading={<Download className="size-3.5" aria-hidden />}>
          {final.isOriginal ? "Download original" : "Download"}
        </Button>
        <p className="text-xs text-muted">Saved from this tab's memory. No request is made.</p>
      </div>
    </Panel>
  );
}

function shorten(name: string, max = 16): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${name.slice(0, Math.max(1, max - ext.length - 1))}…${ext}`;
}
