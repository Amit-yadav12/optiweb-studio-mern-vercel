import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardCopy, Download, FileCode2, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/Button";
import { ErrorState, StatusBadge, useToast } from "@/components/ui/Feedback";
import type { Tone } from "@/lib/status";
import { Field, Select } from "@/components/ui/Form";
import { DefinitionRow, Panel, PanelHeader, StatStrip } from "@/components/ui/Layout";
import { saveBlob } from "@/lib/download";
import { formatBytes, formatNumber } from "@/lib/format";
import { recordActivity } from "@/lib/session-activity";
import { CSS_DRAFT_STORAGE_KEY } from "@/lib/storage-keys";
import { CssInputError, FONT_DISPLAY_VALUES, MAX_CSS_CHARS, POLICY_NOTES, analyzeCss, patchFontDisplay, type CssAnalysis, type CssFinding, type CssPatch, type FontDisplayPolicy } from "@/shared/css";
import { SAMPLE_CSS } from "@/features/fonts/sampleCss";

const POLICIES = POLICY_NOTES;

/** The draft survives a reload of this tab and is gone when the tab closes. A browser that blocks storage simply keeps no draft. */
function readDraft(): string {
  try {
    return window.sessionStorage.getItem(CSS_DRAFT_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(value: string): void {
  try {
    if (value) window.sessionStorage.setItem(CSS_DRAFT_STORAGE_KEY, value);
    else window.sessionStorage.removeItem(CSS_DRAFT_STORAGE_KEY);
  } catch {
    /* storage is blocked or full: the editor still works */
  }
}

/**
 * Analyses a stylesheet and adds `font-display` where it is missing.
 *
 * The stylesheet is parsed and patched by this page, with PostCSS running in
 * the browser. It is not sent anywhere.
 */
export function FontOptimizer({ initialPolicy }: { initialPolicy: FontDisplayPolicy }) {
  const { push } = useToast();
  const [css, setCss] = useState(readDraft);
  const [policy, setPolicy] = useState<FontDisplayPolicy>(initialPolicy);
  const [analysis, setAnalysis] = useState<CssAnalysis | null>(null);
  const [patched, setPatched] = useState<CssPatch | null>(null);
  const [failure, setFailure] = useState<{ message: string; hint?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const updateCss = (value: string) => {
    setCss(value);
    writeDraft(value);
  };

  /** Runs a parser call and turns an input problem into a message. Returns null when the input was refused. */
  const guarded = <T,>(work: () => T): T | null => {
    setFailure(null);
    try {
      return work();
    } catch (error) {
      setFailure(
        error instanceof CssInputError
          ? { message: error.message, hint: error.code === "too_large" ? "Analyse the part of the stylesheet that holds the @font-face rules." : undefined }
          : { message: "The stylesheet could not be processed.", hint: "Your CSS is preserved in the editor." },
      );
      return null;
    }
  };

  const analyze = () => {
    setPatched(null);
    const data = guarded(() => analyzeCss(css, policy));
    if (!data) return;
    setAnalysis(data);
    recordActivity("fonts", { items: 1 });
    push({
      tone: data.parseErrors.length > 0 ? "danger" : data.missingFontDisplay > 0 ? "warn" : "ok",
      title: data.parseErrors.length > 0 ? "The stylesheet could not be parsed" : `${data.fontFaceCount} @font-face rule${data.fontFaceCount === 1 ? "" : "s"} analysed`,
      description: data.parseErrors.length > 0 ? "Fix the reported line, then analyse again." : `${data.missingFontDisplay} missing font-display · ${data.withFontDisplay} already declared`,
    });
  };

  const patch = () => {
    const data = guarded(() => patchFontDisplay(css, policy));
    if (!data) return;
    setPatched(data);
    setAnalysis(data.analysis);
    recordActivity("fonts", { items: 1, inputBytes: data.inputBytes, outputBytes: data.outputBytes });
    push({
      tone: data.rulesPatched.length > 0 ? "ok" : "neutral",
      title: data.rulesPatched.length > 0 ? `${data.rulesPatched.length} rule${data.rulesPatched.length === 1 ? "" : "s"} patched` : "Nothing to patch",
      description: data.rulesPatched.length > 0 ? `font-display: ${policy} inserted · output ${formatBytes(data.outputBytes)}` : "Every eligible rule already declares font-display.",
    });
    requestAnimationFrame(() => outputRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
  };

  const copyOutput = async () => {
    if (!patched) return;
    try {
      await navigator.clipboard.writeText(patched.output);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      push({ tone: "warn", title: "Clipboard unavailable", description: "Select the text and copy it manually." });
    }
  };

  const downloadOutput = () => {
    if (!patched) return;
    saveBlob(new Blob([patched.output], { type: "text/css;charset=utf-8" }), "styles.font-display.css");
  };

  const outputLines = useMemo(() => (patched ? patched.output.split("\n") : []), [patched]);
  const inputLines = useMemo(() => css.split("\n"), [css]);
  const warningLines = useMemo(() => {
    if (!analysis) return new Set<number>();
    return new Set(
      analysis.findings
        .filter((finding: CssFinding) => finding.code === "font-display-missing" && typeof finding.line === "number")
        .map((finding) => finding.line as number),
    );
  }, [analysis]);

  const charCount = css.length;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        {/* -------------------------------------------------------- input */}
        <Panel labelledBy="css-input">
          <PanelHeader
            id="css-input"
            title="Stylesheet input"
            description="Paste CSS or open a .css file. It is parsed by this page and is not sent anywhere."
            meta={analysis ? <StatusBadge tone={analysis.parseErrors.length ? "danger" : "neutral"}>{charCount.toLocaleString()} chars</StatusBadge> : null}
            actions={
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => updateCss(SAMPLE_CSS)} leading={<Sparkles className="size-3.5" aria-hidden />}>
                  Load sample
                </Button>
                <label className={buttonClass({ variant: "secondary", size: "sm", className: "cursor-pointer" })}>
                  Open .css
                  <input
                    type="file"
                    accept=".css,text/css"
                    className="sr-only"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file) return;
                      // A character is at least one byte, so a file above the limit in bytes may still fit. The parser checks the exact length.
                      if (file.size > MAX_CSS_CHARS * 4) {
                        push({ tone: "warn", title: "File too large", description: `A stylesheet of up to ${(MAX_CSS_CHARS / 1_000_000).toFixed(0)} million characters can be analysed.` });
                        return;
                      }
                      try {
                        updateCss(await file.text());
                      } catch {
                        push({ tone: "danger", title: "The file could not be read", description: "Select it again." });
                      }
                    }}
                  />
                </label>
              </div>
            }
          />

          <div className="overflow-hidden rounded-md border border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line bg-surface-sunken/60 px-3 py-1.5">
              <span className="font-mono text-2xs text-muted">styles.css</span>
              <span className="font-mono text-2xs text-muted tnum">{inputLines.length} lines</span>
            </div>
            <label htmlFor="css-editor" className="sr-only">
              CSS source to analyse
            </label>
            <textarea
              id="css-editor"
              value={css}
              spellCheck={false}
              onChange={(event) => updateCss(event.target.value)}
              placeholder="Paste the @font-face rules you ship…"
              className="code-pane min-h-[320px] w-full resize-y bg-surface px-3 py-2.5 text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/30"
            />
          </div>

          <div className="mt-4 flex flex-col gap-4">
            <Field
              label="font-display policy"
              htmlFor="policy"
              hint={POLICIES[policy].tradeOff}
            >
              <div className="sm:max-w-56">
                <Select id="policy" value={policy} onChange={(event) => setPolicy(event.target.value as FontDisplayPolicy)}>
                  {FONT_DISPLAY_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {POLICIES[value].label}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={analyze} disabled={!css.trim()}>
                <FileCode2 className="size-3.5" aria-hidden />
                Analyze
              </Button>
              <Button variant="primary" onClick={patch} disabled={!css.trim()}>
                Apply font-display
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  updateCss("");
                  setAnalysis(null);
                  setPatched(null);
                  setFailure(null);
                }}
                aria-label="Clear editor"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </div>
          </div>

          <p className="mt-3 text-2xs leading-relaxed text-muted">
            The sample button loads illustrative CSS containing one rule that already declares
            <span className="font-mono"> font-display</span>, two that do not, and one malformed rule with no
            <span className="font-mono"> src</span>. It is never treated as your own data.
          </p>

          {failure ? (
            <div className="mt-4">
              <ErrorState title="Not analysed" message={failure.message} hint={failure.hint} />
            </div>
          ) : null}
        </Panel>

        {/* ------------------------------------------------------ analysis */}
        <div className="flex flex-col gap-6">
          <Panel labelledBy="analysis">
            <PanelHeader
              id="analysis"
              title="Analysis"
              description="Findings come from the parsed stylesheet, not from pattern matching."
              meta={
                analysis ? (
                  <StatusBadge tone={analysis.parseErrors.length ? "danger" : analysis.missingFontDisplay > 0 ? "warn" : "ok"}>
                    {analysis.parseErrors.length ? "parse error" : analysis.missingFontDisplay > 0 ? "action available" : "no gaps"}
                  </StatusBadge>
                ) : null
              }
            />
            {!analysis ? (
              <p className="py-8 text-center text-sm text-muted">
                Paste CSS and select <span className="text-ink">Analyze</span> to see the findings.
              </p>
            ) : (
              <>
                <StatStrip
                  items={[
                    { label: "@font-face", value: formatNumber(analysis.fontFaceCount) },
                    { label: "Has font-display", value: formatNumber(analysis.withFontDisplay) },
                    { label: "Missing", value: formatNumber(analysis.missingFontDisplay) },
                    { label: "Malformed", value: formatNumber(analysis.malformed) },
                  ]}
                />
                <ul className="mt-4 flex flex-col gap-2">
                  {analysis.findings.map((finding) => (
                    <li key={finding.id} className="border border-line px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge tone={findingTone(finding.severity)}>{finding.severity}</StatusBadge>
                        <p className="text-sm font-medium text-ink">{finding.title}</p>
                        {finding.line ? <span className="font-mono text-2xs text-muted">line {finding.line}</span> : null}
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-muted">{finding.detail}</p>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 border-t border-line pt-3">
                  <p className="text-2xs font-medium tracking-[0.1em] text-muted uppercase">Policy behaviour</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted">{POLICIES[policy].behaviour}</p>
                </div>
              </>
            )}
          </Panel>
        </div>
      </div>

      {/* --------------------------------------------------- before / after */}
      {patched ? (
        <div ref={outputRef} className="animate-fade-up flex flex-col gap-4">
          <Panel padded={false} labelledBy="diff">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-5">
              <div>
                <h2 id="diff" className="text-sm font-semibold text-ink">
                  Before and after
                </h2>
                <p className="mt-1 text-xs text-muted">
                  {patched.rulesPatched.length === 0
                    ? "No rule needed changes; the output is your input."
                    : `${patched.rulesPatched.length} declaration${patched.rulesPatched.length === 1 ? "" : "s"} inserted. Highlighted lines are new.`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={copyOutput} leading={copied ? <Check className="size-3.5" aria-hidden /> : <ClipboardCopy className="size-3.5" aria-hidden />}>
                  {copied ? "Copied" : "Copy output"}
                </Button>
                <button
                  type="button"
                  className={buttonClass({ variant: "primary", size: "sm" })}
                  onClick={downloadOutput}
                >
                  <Download className="size-3.5" aria-hidden />
                  Download CSS
                </button>
                <Button variant="ghost" size="sm" onClick={() => updateCss(patched.output)} leading={<RefreshCw className="size-3.5" aria-hidden />}>
                  Load into editor
                </Button>
              </div>
            </div>
            <div className="mt-4 grid gap-px border-y border-line bg-line lg:grid-cols-2">
              <CodePane title="Original CSS" lines={inputLines} highlight={warningLines} tone="warn" />
              <CodePane
                title="Optimized CSS"
                lines={outputLines}
                highlight={new Set(patched.changedLines)}
                tone="ok"
                empty={outputLines.length === 0}
              />
            </div>
            <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
              {[
                { label: "Input size", value: formatBytes(patched.inputBytes) },
                { label: "Output size", value: formatBytes(patched.outputBytes) },
                { label: "Bytes added", value: formatBytes(Math.max(0, patched.outputBytes - patched.inputBytes)) },
                { label: "Lines changed", value: String(patched.changedLines.length) },
              ].map((cell) => (
                <div key={cell.label} className="bg-surface px-4 py-3">
                  <dt className="text-2xs font-medium tracking-[0.1em] text-muted uppercase">{cell.label}</dt>
                  <dd className="mt-1 font-mono text-sm tnum text-ink">{cell.value}</dd>
                </div>
              ))}
            </dl>
            <div className="px-4 py-3 sm:px-5">
              <p className="text-2xs leading-relaxed text-muted">
                The download is the exact text shown in “Optimized CSS”, saved from this page. Adding
                <span className="font-mono"> font-display</span> does not change how large your font files are —
                it changes how long text is invisible while they load.
              </p>
            </div>
          </Panel>
        </div>
      ) : (
        <Panel as="aside">
          <div className="flex gap-3.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-md border border-line bg-surface-sunken text-accent">
              <FileCode2 className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">What the patcher will and will not do</h2>
              <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-muted">
                It inserts <span className="font-mono">font-display</span> into parsed
                <span className="font-mono"> @font-face</span> rules that declare a
                <span className="font-mono"> src</span> and no <span className="font-mono">font-display</span>. Rules
                without a source are reported and left untouched, a value that is already declared is never rewritten,
                and every other rule in the stylesheet is preserved byte for byte. The parsing and the patch happen in
                this browser: the stylesheet is not uploaded.
              </p>
              <dl className="mt-3 max-w-xl">
                <DefinitionRow label="Default policy" value={`font-display: ${policy}`} />
                <DefinitionRow label="Parser" value="PostCSS, running in this browser" />
              </dl>
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}

function findingTone(severity: CssFinding["severity"]): Tone {
  if (severity === "issue") return "danger";
  if (severity === "warning") return "warn";
  return "neutral";
}

function CodePane({
  title,
  lines,
  highlight,
  tone,
  empty,
}: {
  title: string;
  lines: string[];
  highlight: Set<number>;
  tone: "ok" | "warn";
  empty?: boolean;
}) {
  const toneClass = tone === "ok" ? "bg-ok-soft border-l-ok" : "bg-warn-soft border-l-warn";
  return (
    <section aria-label={title} className="bg-surface">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <h3 className="text-2xs font-medium tracking-[0.1em] text-muted uppercase">{title}</h3>
        <span className="font-mono text-2xs text-muted tnum">{lines.length} lines</span>
      </header>
      <div className="max-h-[420px] overflow-auto">
        {empty ? (
          <p className="px-3 py-8 text-center text-xs text-muted">Nothing to display.</p>
        ) : (
          <ol className="code-pane min-w-full">
            {lines.map((line, index) => {
              const marked = highlight.has(index + 1);
              return (
                <li
                  key={`${index}-${line.slice(0, 8)}`}
                  className={`flex gap-3 border-l-2 ${marked ? `${toneClass} font-medium` : "border-l-transparent"}`}
                >
                  <span className="w-8 shrink-0 pr-1 text-right text-muted select-none">{index + 1}</span>
                  <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{line || " "}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
