import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileSearch, Info, ScanSearch, TriangleAlert, Wand2 } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState, ErrorState, ProgressIndicator, StatusBadge, useToast } from "@/components/ui/Feedback";
import { statusToneFor } from "@/lib/status";
import { Panel, PanelHeader, StatStrip } from "@/components/ui/Layout";
import { FileDropzone } from "@/components/ui/FileDropzone";
import { formatBytes, formatDimensions } from "@/lib/format";
import { recordActivity } from "@/lib/session-activity";
import { readAsset } from "@/features/assets/readAsset";
import { stageFilesForOptimizer } from "@/features/assets/transfer";
import { analyzeAssets, type AssetAnalysis, type AssetFindingCode, type AssetReport } from "@/shared/assets";

const FINDING_LABEL: Record<AssetFindingCode, string> = {
  "large-file": "Large file",
  "oversized-dimensions": "Large dimensions",
  "format-advice": "Format",
  animated: "Animation",
  "location-data": "Location data",
  "name-mismatch": "Name and contents differ",
  damaged: "Damaged file",
  vector: "Vector source",
  "svg-script": "Script in SVG",
  "font-display-missing": "font-display missing",
  "font-display-ok": "font-display",
  "no-font-face": "No webfonts",
  "css-syntax": "CSS syntax",
  "css-too-large": "Not parsed",
  unrecognised: "Not recognised",
};

/** Most files one analysis takes. Each is read from disk, so a very large selection would keep the tab busy. */
const MAX_FILES = 200;

/**
 * Inspects files the user selected: image headers and stylesheets.
 *
 * The analysis runs in this page. A file is read by the browser, at most its
 * first megabyte for an image, and nothing is sent to a server.
 */
export function AssetAnalyzer({ thresholdKb }: { thresholdKb: number }) {
  const { push } = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AssetAnalysis | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  /** The selected files, by report ID, so a result can be handed to the Image Optimizer. */
  const filesRef = useRef(new Map<string, File>());
  const runRef = useRef(0);

  const analyze = async (selected: File[]) => {
    if (selected.length === 0) return;
    const files = selected.slice(0, MAX_FILES);
    const run = (runRef.current += 1);
    setBusy(true);
    setFailure(null);
    setLeft(selected.length - files.length);
    try {
      const inputs = [];
      for (const file of files) inputs.push(await readAsset(file));
      if (run !== runRef.current) return;
      const analysis = analyzeAssets(inputs, { thresholdKb });
      filesRef.current = new Map(analysis.files.map((report, index) => [report.id, files[index]]));
      setResult(analysis);
      recordActivity("assets", { items: analysis.files.length, inputBytes: analysis.files.reduce((sum, report) => sum + report.bytes, 0) });
      push({
        tone: analysis.summary.findings > 0 ? "warn" : "ok",
        title: `${analysis.files.length} file${analysis.files.length === 1 ? "" : "s"} inspected in this tab`,
        description: `${analysis.summary.findings} finding${analysis.summary.findings === 1 ? "" : "s"} at a ${thresholdKb} KB threshold.`,
      });
    } catch {
      if (run === runRef.current) setFailure("A file could not be read. It may have been moved or deleted after it was selected.");
    } finally {
      if (run === runRef.current) setBusy(false);
    }
  };

  const sendToOptimizer = (reports: AssetReport[]) => {
    const files = reports.map((report) => filesRef.current.get(report.id)).filter((file): file is File => file !== undefined);
    if (files.length === 0) return;
    stageFilesForOptimizer(files);
    navigate("/app/images");
  };

  const optimizable = (result?.files ?? []).filter((report) => report.optimizable);

  return (
    <div className="flex flex-col gap-6">
      <Panel labelledBy="analyzer-select">
        <PanelHeader
          id="analyzer-select"
          title="Inspect files"
          description="Image headers are read for format, dimensions and metadata; stylesheets are parsed for font-loading gaps. The files stay in this browser."
          meta={<StatusBadge tone="neutral">{thresholdKb} KB threshold</StatusBadge>}
        />
        <FileDropzone
          accept="image/*,.css,text/css,.svg,.heic,.heif,.tif,.tiff,.avif"
          multiple
          disabled={busy}
          onFiles={(files) => void analyze(files)}
          icon={<ScanSearch className="size-4.5" aria-hidden />}
          title="Drop images or stylesheets"
          description="Findings are based on the file itself, not on how a page uses it."
          constraints="Images of any common format, SVG and .css files. Nothing is uploaded: the analysis reads the files where they are."
        />
        {busy ? (
          <div className="mt-4">
            <ProgressIndicator label="Reading file headers…" />
          </div>
        ) : null}
        {failure ? (
          <div className="mt-4">
            <ErrorState title="Analysis stopped" message={failure} hint="Select the files again." />
          </div>
        ) : null}
        {left > 0 ? <p className="mt-3 text-xs text-warn">{left} file{left === 1 ? " was" : "s were"} left out: one analysis takes up to {MAX_FILES} files.</p> : null}
      </Panel>

      {result ? (
        <section className="animate-fade-up flex flex-col gap-6" aria-labelledby="analyzer-results" data-testid="asset-results">
          <div>
            <h2 id="analyzer-results" className="mb-3 text-sm font-semibold text-ink">
              Results
            </h2>
            <StatStrip
              items={[
                { label: "Files inspected", value: String(result.summary.filesScanned) },
                { label: "Findings", value: String(result.summary.findings), hint: `${result.summary.warnings} warning${result.summary.warnings === 1 ? "" : "s"} · ${result.summary.issues} issue${result.summary.issues === 1 ? "" : "s"}` },
                { label: "Threshold", value: `${thresholdKb} KB`, hint: "change it in Settings" },
                { label: "Sent to a server", value: "0 B", hint: "read in this tab" },
              ]}
            />
          </div>

          {optimizable.length > 1 ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={() => sendToOptimizer(optimizable)} leading={<Wand2 className="size-3.5" aria-hidden />}>
                Optimize all {optimizable.length} images
              </Button>
              <p className="text-xs text-muted">Opens the Image Optimizer with these files already in its queue. They are handed over in memory.</p>
            </div>
          ) : null}

          <Panel as="aside">
            <div className="flex gap-3.5">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-warn-border bg-warn-soft text-warn">
                <TriangleAlert className="size-3.5" aria-hidden />
              </span>
              <p className="text-xs leading-relaxed text-muted">
                <span className="font-medium text-ink">Scope of this analysis.</span> It sees only the files you selected. It cannot measure how an asset
                is rendered, how often it is requested, or its effect on Core Web Vitals. Findings marked{" "}
                <span className="font-mono text-2xs">heuristic</span> compare the file against a threshold rather than state a fact about it.
              </p>
            </div>
          </Panel>

          {result.files.map((report) => {
            const notable = report.findings.filter((finding) => finding.severity !== "info").length;
            return (
              <Panel key={report.id} as="article" padded={false}>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium text-ink" title={report.filename}>
                      {report.filename}
                    </h3>
                    <p className="mt-0.5 font-mono text-2xs text-muted">
                      {report.format ? report.format.toUpperCase() : "unknown"} · {formatBytes(report.bytes)}
                      {report.kind === "image" ? ` · ${formatDimensions(report.width, report.height)}` : ""}
                    </p>
                    {report.facts.length > 0 ? <p className="mt-0.5 text-2xs text-muted">{report.facts.join(" · ")}</p> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge tone={notable > 0 ? "warn" : "neutral"}>{notable > 0 ? `${notable} finding${notable === 1 ? "" : "s"}` : "no issues"}</StatusBadge>
                    {report.optimizable ? (
                      <Button variant="secondary" size="sm" onClick={() => sendToOptimizer([report])} leading={<Wand2 className="size-3.5" aria-hidden />} aria-label={`Optimize ${report.filename}`}>
                        Optimize
                      </Button>
                    ) : null}
                  </div>
                </div>
                <ul className="flex flex-col divide-y divide-line">
                  {report.findings.map((finding) => (
                    <li key={finding.id} className="flex gap-3 px-4 py-3 sm:px-5" data-finding={finding.code}>
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-faint" aria-hidden />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-2xs tracking-wide text-muted uppercase">{FINDING_LABEL[finding.code]}</span>
                          <StatusBadge tone={statusToneFor(finding.severity)}>{finding.severity}</StatusBadge>
                          {finding.heuristic ? <span className="font-mono text-2xs text-muted">heuristic</span> : null}
                        </div>
                        <p className="mt-1.5 text-xs text-ink-soft">{finding.evidence}</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted">{finding.recommendation}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </Panel>
            );
          })}
        </section>
      ) : (
        <Panel padded={false}>
          <EmptyState
            icon={<FileSearch className="size-4" aria-hidden />}
            title="Nothing analysed yet"
            description="Select an image or a stylesheet to see its real dimensions, weight, metadata and evidence-based recommendations."
            action={
              <ButtonLink href="/app/images" variant="primary" size="sm">
                Optimize an image instead
              </ButtonLink>
            }
          />
        </Panel>
      )}

      <Panel as="aside">
        <div className="flex gap-3.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-md border border-line bg-surface-sunken text-accent">
            <Info className="size-4" aria-hidden />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-ink">From analysis to optimization</h2>
            <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-muted">
              For a still raster image, the result card offers <span className="text-ink">Optimize</span>. The file is handed to the Image Optimizer in
              this tab's memory, so you measure the actual conversion without selecting it again. Nothing is kept after you close the tab.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
