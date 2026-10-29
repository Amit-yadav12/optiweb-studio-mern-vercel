import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardCopy, Download, FileCode2, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/Button";
import { ErrorState, StatusBadge, useToast} from "@/components/ui/Feedback";
import type { Tone } from "@/lib/status";
import { Field, Select } from "@/components/ui/Form";
import { DefinitionRow, Panel, PanelHeader, StatStrip } from "@/components/ui/Layout";
import { ApiClientError, api, artifactUrl } from "@/lib/api-client";
import { formatBytes, formatNumber } from "@/lib/format";
import type { CssAnalysis, CssPatchResponse, CssFinding, FontDisplayPolicy } from "@/types/domain";
import { SAMPLE_CSS } from "@/features/fonts/sampleCss";

type PolicyInfo = { label: string; behaviour: string; tradeOff: string };

const POLICIES: Record<FontDisplayPolicy, PolicyInfo> = {
  auto: {
    label: "auto",
    behaviour: "The browser applies its own default font-display behaviour.",
    tradeOff: "Usually behaves like `block`: hidden text while the font downloads.",
  },
  block: {
    label: "block",
    behaviour: "Text stays invisible for up to ~3 seconds while the font loads.",
    tradeOff: "No fallback flash, but invisible content is possible on slow connections.",
  },
  swap: {
    label: "swap",
    behaviour: "Fallback text renders immediately, then swaps when the real font arrives.",
    tradeOff: "No invisible text; a visible re-layout can still occur.",
  },
  fallback: {
    label: "fallback",
    behaviour: "Very short block period (~100 ms) followed by a short swap window.",
    tradeOff: "A balanced default for body text on most content sites.",
  },
  optional: {
    label: "optional",
    behaviour: "Short block period; the browser may keep the fallback for the entire visit.",
    tradeOff: "Most stable layout, but the webfont may never render on slow networks.",
  },
};

export function FontOptimizer({ initialPolicy }: { initialPolicy: FontDisplayPolicy }) {
  const { push } = useToast();
  const [css, setCss] = useState("");
  const [policy, setPolicy] = useState<FontDisplayPolicy>(initialPolicy);
  const [analysis, setAnalysis] = useState<CssAnalysis | null>(null);
  const [patched, setPatched] = useState<CssPatchResponse | null>(null);
  const [busy, setBusy] = useState<"analyze" | "patch" | null>(null);
  const [failure, setFailure] = useState<{ message: string; hint?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (css) return;
    // Restore the last analysed stylesheet if this session stored one.
    const draft = window.sessionStorage.getItem("optiweb:css-draft");
    if (draft) setCss(draft);
  }, [css]);

  const updateCss = (value: string) => {
    setCss(value);
    window.sessionStorage.setItem("optiweb:css-draft", value);
  };

  const analyze = async () => {
    if (busy) return;
    setBusy("analyze");
    setFailure(null);
    setPatched(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const data = await api.post<CssAnalysis & { policies?: unknown }>("/api/v1/css/analyze", { css }, { signal: controller.signal });
      setAnalysis(data);
      push({
        tone: data.parseErrors.length > 0 ? "danger" : data.missingFontDisplay > 0 ? "warn" : "ok",
        title:
          data.parseErrors.length > 0
            ? "The stylesheet could not be parsed"
            : `${data.fontFaceCount} @font-face rule${data.fontFaceCount === 1 ? "" : "s"} analysed`,
        description:
          data.parseErrors.length > 0
            ? "Fix the reported line, then analyse again."
            : `${data.missingFontDisplay} missing font-display · ${data.withFontDisplay} already declared`,
      });
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "cancelled") return;
      const message = error instanceof Error ? error.message : "Analysis failed.";
      setFailure({ message });
    } finally {
      setBusy(null);
    }
  };

  const patch = async () => {
    if (busy) return;
    setBusy("patch");
    setFailure(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const data = await api.post<CssPatchResponse>("/api/v1/css/patch-font-display", { css, policy }, { signal: controller.signal });
      setPatched(data);
      setAnalysis(data.analysis);
      push({
        tone: data.rulesPatched.length > 0 ? "ok" : "neutral",
        title:
          data.rulesPatched.length > 0
            ? `${data.rulesPatched.length} rule${data.rulesPatched.length === 1 ? "" : "s"} patched`
            : "Nothing to patch",
        description:
          data.rulesPatched.length > 0
            ? `font-display: ${policy} inserted · output ${formatBytes(data.outputBytes)}`
            : "Every eligible rule already declares font-display.",
      });
      requestAnimationFrame(() => outputRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "cancelled") return;
      const message = error instanceof Error ? error.message : "The patch could not be generated.";
      setFailure({ message, hint: "Your CSS is preserved in the editor." });
    } finally {
      setBusy(null);
    }
  };

  const copyOutput = async () => {
    if (!patched) return;
    try {
      await navigator.clipboard.writeText(patched.output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      push({ tone: "warn", title: "Clipboard unavailable", description: "Select the text and copy it manually." });
    }
  };

  const downloadOutput = () => {
    if (!patched) return;
    // The stored artifact is authoritative; fall back to a client-side blob when
    // history storage is unavailable so the displayed output is never lost.
    if (patched.artifactId) {
      window.location.href = artifactUrl(patched.artifactId);
      return;
    }
    const blob = new Blob([patched.output], { type: "text/css;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "styles.font-display.css";
    anchor.click();
    URL.revokeObjectURL(url);
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
        <Panel aria-labelledby="css-input">
          <PanelHeader
            id="css-input"
            title="Stylesheet input"
            description="Paste CSS or upload a .css file. Nothing is changed until you apply a policy."
            meta={analysis ? <StatusBadge tone={analysis.parseErrors.length ? "danger" : "neutral"}>{charCount.toLocaleString()} chars</StatusBadge> : null}
            actions={
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => updateCss(SAMPLE_CSS)} leading={<Sparkles className="size-3.5" aria-hidden />}>
                  Load sample
                </Button>
                <label className={buttonClass({ variant: "secondary", size: "sm", className: "cursor-pointer" })}>
                  Upload .css
                  <input
                    type="file"
                    accept=".css,text/css"
                    className="sr-only"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file) return;
                      if (file.size > 400_000) {
                        push({ tone: "warn", title: "File too large", description: "Stylesheets are limited to 400,000 characters." });
                        return;
                      }
                      updateCss(await file.text());
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

          <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <Field
              label="font-display policy"
              htmlFor="policy"
              hint={POLICIES[policy].tradeOff}
            >
              <Select id="policy" value={policy} onChange={(event) => setPolicy(event.target.value as FontDisplayPolicy)}>
                {(Object.keys(POLICIES) as FontDisplayPolicy[]).map((value) => (
                  <option key={value} value={value}>
                    {POLICIES[value].label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={analyze} loading={busy === "analyze"} disabled={!css.trim()}>
                <FileCode2 className="size-3.5" aria-hidden />
                Analyze
              </Button>
              <Button variant="primary" onClick={patch} loading={busy === "patch"} disabled={!css.trim()}>
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
              <ErrorState title="Request failed" message={failure.message} hint={failure.hint} />
            </div>
          ) : null}
        </Panel>

        {/* ------------------------------------------------------ analysis */}
        <div className="flex flex-col gap-6">
          <Panel aria-labelledby="analysis">
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
          <Panel padded={false} aria-labelledby="diff">
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
                The download is the exact text shown in “Optimized CSS”. Adding
                <span className="font-mono"> font-display</span> does not change how large your font files are —
                it changes how long text is invisible while they load.
              </p>
            </div>
          </Panel>
          {patched.persisted ? null : (
            <ErrorState
              title="History storage is offline"
              message="The patched CSS is shown and downloadable from your browser, but it was not stored in history."
              hint="Configure `MONGODB_URI` to persist future runs. The CSS transformation can still be inspected if persistence is unavailable."
            />
          )}
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
                <span className="font-mono"> src</span>. Rules without a valid source are reported and left
                untouched, existing declarations are only rewritten if you apply a different policy, and every
                other rule in the stylesheet is preserved byte for byte.
              </p>
              <dl className="mt-3 max-w-xl">
                <DefinitionRow label="Default policy" value={`font-display: ${policy}`} />
                <DefinitionRow label="Parser" value="postcss (spec-compliant, error-tolerant)" />
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
                  <span className="w-8 shrink-0 pr-1 text-right text-faint select-none">{index + 1}</span>
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
