import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileSearch, Info, ScanSearch, TriangleAlert, Wand2 } from "lucide-react";
import { Button, ButtonLink, buttonClass } from "@/components/ui/Button";
import { EmptyState, ErrorState, ProgressIndicator, StatusBadge, useToast} from "@/components/ui/Feedback";
import { statusToneFor } from "@/lib/status";
import { Panel, PanelHeader, StatStrip } from "@/components/ui/Layout";
import { FileDropzone } from "@/components/ui/FileDropzone";
import { api } from "@/lib/api-client";
import { formatBytes, formatDimensions } from "@/lib/format";
import { stageFileForOptimizer } from "@/features/assets/transfer";
import type { AssetAnalysisResponse, AssetFinding, Preferences } from "@/types/domain";

const FINDING_LABEL: Record<AssetFinding["code"], string> = {
  "large-file": "Large file",
  "oversized-dimensions": "Oversized dimensions",
  "format-conversion": "Format conversion",
  "png-for-photo": "PNG may be heavy",
  "svg-not-processed": "Vector source",
  "font-display-missing": "font-display missing",
  "css-syntax": "CSS syntax error",
  "no-findings": "Baseline",
};

export function AssetAnalyzer({ defaults }: { defaults: { thresholdKb: number; maxFileMb: number; maxFiles: number } }) {
  const { push } = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [thresholdKb, setThresholdKb] = useState(defaults.thresholdKb);
  const [result, setResult] = useState<AssetAnalysisResponse | null>(null);
  const [failure, setFailure] = useState<{ message: string; hint?: string } | null>(null);
  const [queue, setQueue] = useState<File[]>([]);

  useEffect(() => {
    api
      .get<Preferences>("/api/v1/preferences")
      .then((prefs) => setThresholdKb(prefs.analyzerThresholdKb))
      .catch(() => {
        /* built-in default */
      });

    // Check for ?inspect=<artifactId>
    const params = new URLSearchParams(window.location.search);
    const inspectId = params.get("inspect");
    if (!inspectId) return;

    let cancelled = false;
    fetch(`/api/v1/artifacts/${inspectId}?inline=1`, { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error("Stored artifact could not be retrieved.");
        const blob = await res.blob();
        const header = res.headers.get("content-disposition") ?? "";
        const match = /filename="([^"]+)"/.exec(header);
        const name = match ? match[1] : "inspected-asset";
        const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
        if (!cancelled) {
          setQueue([file]);
          void analyze([file]);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          push({
            tone: "danger",
            title: "Could not load asset",
            description: err instanceof Error ? err.message : "Artifact retrieval failed",
          });
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const analyze = async (files: File[]) => {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setFailure(null);
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    form.append("thresholdKb", String(thresholdKb));
    try {
      const data = await api.post<AssetAnalysisResponse>("/api/v1/assets/analyze", form);
      setResult(data);
      const findings = data.summary.findings;
      push({
        tone: findings > 0 ? "warn" : "ok",
        title: `${data.files.length} file${data.files.length === 1 ? "" : "s"} inspected`,
        description: `${findings} finding${findings === 1 ? "" : "s"} reported at a ${thresholdKb} KB threshold.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The analysis could not be completed.";
      setFailure({ message, hint: "Your files are still queued below — you can retry without re-selecting them." });
    } finally {
      setBusy(false);
    }
  };

  const sendToOptimizer = (file: File | undefined) => {
    if (!file) return;
    stageFileForOptimizer(file);
    navigate("/app/images");
  };

  const totalFindings = result?.summary.findings ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <Panel aria-labelledby="analyzer-select">
        <PanelHeader
          id="analyzer-select"
          title="Inspect uploaded assets"
          description="Images are decoded for true dimensions; stylesheets are parsed for font-loading gaps."
          meta={<StatusBadge tone="neutral">{thresholdKb} KB threshold</StatusBadge>}
        />
        <FileDropzone
          accept="image/jpeg,image/png,image/webp,image/avif,image/gif,image/tiff,.css,text/css"
          multiple
          disabled={busy}
          onFiles={(files) => {
            setQueue(files);
            void analyze(files);
          }}
          icon={<ScanSearch className="size-4.5" aria-hidden />}
          title="Drop images or a stylesheet"
          description="Findings are based on the file itself — not on how your page uses it."
          constraints={`Images and .css · ${defaults.maxFileMb} MB per file · ${defaults.maxFiles} files per batch`}
        />
        {busy ? (
          <div className="mt-4">
            <ProgressIndicator label="Decoding and measuring files…" />
          </div>
        ) : null}
        {failure ? (
          <div className="mt-4">
            <ErrorState
              title="Analysis failed"
              message={failure.message}
              hint={failure.hint}
              action={
                <Button variant="secondary" size="sm" onClick={() => void analyze(queue)}>
                  Retry analysis
                </Button>
              }
            />
          </div>
        ) : null}
      </Panel>

      {result ? (
        <section className="animate-fade-up flex flex-col gap-6" aria-labelledby="analyzer-results">
          <div>
            <h2 id="analyzer-results" className="mb-3 text-sm font-semibold text-ink">
              Results
            </h2>
            <StatStrip
              items={[
                { label: "Files scanned", value: String(result.summary.filesScanned) },
                { label: "Findings", value: String(totalFindings) },
                { label: "Threshold", value: `${thresholdKb} KB`, hint: "change it in Settings" },
                { label: "Stored", value: result.persisted ? "in history" : "not stored", hint: result.persisted ? undefined : "storage offline" },
              ]}
            />
          </div>

          <Panel as="aside">
            <div className="flex gap-3.5">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-warn-border bg-warn-soft text-warn">
                <TriangleAlert className="size-3.5" aria-hidden />
              </span>
              <p className="text-xs leading-relaxed text-muted">
                <span className="font-medium text-ink">Scope of this analysis.</span> OptiWeb sees only the files you
                uploaded. It cannot measure how an asset is rendered, how often it is requested, or its effect on
                Core Web Vitals. Findings marked <span className="font-mono text-2xs">heuristic</span> compare the
                file against the threshold configured in Settings rather than against a measured rule.
              </p>
            </div>
          </Panel>

          {result.files.map((file) => (
            <Panel key={file.id} as="article" padded={false}>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink" title={file.filename}>
                    {file.filename}
                  </p>
                  <p className="mt-0.5 font-mono text-2xs text-muted">
                    {file.format ? file.format.toUpperCase() : "unknown"} · {formatBytes(file.bytes)} ·{" "}
                    {formatDimensions(file.width, file.height)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge tone={file.findings.length > 1 ? "warn" : "neutral"}>
                    {file.findings.length - 1 >= 1 ? `${file.findings.length - 1} finding(s)` : "no issues"}
                  </StatusBadge>
                  {file.kind === "image" && file.format !== "svg" ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const staged = queue.find((entry) => entry.name === file.filename);
                        sendToOptimizer(staged);
                      }}
                      leading={<Wand2 className="size-3.5" aria-hidden />}
                    >
                      Optimize
                    </Button>
                  ) : null}
                </div>
              </div>
              <ul className="flex flex-col divide-y divide-line">
                {file.findings.map((finding) => (
                  <li key={finding.id} className="flex gap-3 px-4 py-3 sm:px-5">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-faint" aria-hidden />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-2xs tracking-wide text-muted uppercase">
                          {FINDING_LABEL[finding.code]}
                        </span>
                        <StatusBadge tone={statusToneFor(finding.severity)}>{finding.severity}</StatusBadge>
                        {finding.heuristic ? (
                          <span className="font-mono text-2xs text-muted">heuristic</span>
                        ) : null}
                      </div>
                      <p className="mt-1.5 text-xs text-ink-soft">{finding.evidence}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted">{finding.recommendation}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </section>
      ) : (
        <Panel padded={false}>
          <EmptyState
            icon={<FileSearch className="size-4" aria-hidden />}
            title="Nothing analysed in this session yet"
            description="Upload an image or stylesheet to see measured dimensions, weight and evidence-based recommendations."
            action={
              <ButtonLinkish />
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
              When a file is a raster image, the result card offers <span className="text-ink">Optimize</span>. The
              file is handed to the Image Optimizer in memory, so you measure the actual conversion without
              re-selecting it. Nothing is cached between browser sessions.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function ButtonLinkish() {
  return (
    <ButtonLink href="/app/images" variant="primary" size="sm">
      Optimize an image instead
    </ButtonLink>
  );
}

