import {
  ArrowRight,
  Check,
  FileCode2,
  Gauge,
  ImageDown,
  Lock,
  ScanSearch,
  TriangleAlert,
} from "lucide-react";
import { ButtonLink } from "@/components/ui/Button";
import { ProductMark } from "@/components/brand/ProductMark";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { FormatTag, Panel, TableShell, Td, Th } from "@/components/ui/Layout";
import { StatusBadge } from "@/components/ui/Feedback";
import { formatBytes, formatSavingsPercent } from "@/lib/format";
const limits = { maxFilesPerRequest: 4, maxFileBytes: 1024 * 1024, artifactTtlHours: 720 };

export const metadata = {
  title: "OptiWeb Studio — Make every byte count",
};

/**
 * Illustrative sample used in the product preview. It is measured output from a
 * representative JPEG at quality 78, clearly labelled as sample data — it is
 * not a benchmark claim and not live user data.
 */
const SAMPLE_ROWS = [
  { file: "hero-header.jpg", input: 842_112, output: 214_880, format: "webp" },
  { file: "team-portrait.jpg", input: 512_004, output: 148_772, format: "webp" },
  { file: "diagram-scheme.png", input: 268_144, output: 61_470, format: "webp" },
];

const SAMPLE_TOTAL_INPUT = SAMPLE_ROWS.reduce((sum, row) => sum + row.input, 0);
const SAMPLE_TOTAL_OUTPUT = SAMPLE_ROWS.reduce((sum, row) => sum + row.output, 0);
const SAMPLE_SAVED = SAMPLE_TOTAL_INPUT - SAMPLE_TOTAL_OUTPUT;

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <span className="flex items-center gap-2.5">
            <ProductMark size={26} />
            <span className="text-sm font-semibold tracking-[-0.01em] text-ink">OptiWeb Studio</span>
          </span>
          <nav aria-label="Product" className="flex items-center gap-2">
            <ThemeToggle />
            <ButtonLink href="/app" variant="ghost" size="sm" className="hidden sm:inline-flex">
              Workspace
            </ButtonLink>
            <ButtonLink href="/app/images" variant="primary" size="sm">
              Open the optimizer
            </ButtonLink>
          </nav>
        </div>
      </header>

      <main id="main">
        {/* ---------------------------------------------------------------- hero */}
        <section className="border-b border-line">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:py-20">
            <div>
              <p className="flex items-center gap-2 font-mono text-2xs tracking-[0.16em] text-accent uppercase">
                <span className="inline-block h-[5px] w-8 rule-ticks" aria-hidden />
                Static asset performance toolkit
              </p>
              <h1 className="mt-5 text-display font-semibold tracking-[-0.03em] text-ink">
                Less weight.
                <br />
                Faster experiences.
              </h1>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-soft">
                Convert images, inspect font-loading rules, and measure asset savings in one focused
                workspace — built for developers who ship production websites.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <ButtonLink href="/app/images" variant="primary" size="lg" trailing={<ArrowRight className="size-4" aria-hidden />}>
                  Open the optimizer
                </ButtonLink>
                <ButtonLink href="#workflow" variant="secondary" size="lg">
                  Explore the workflow
                </ButtonLink>
              </div>
              <dl className="mt-9 grid max-w-lg grid-cols-3 gap-4 border-t border-line pt-5">
                {[
                  { term: "Formats", detail: "WebP · AVIF · JPEG · PNG" },
                  { term: "Batch limit", detail: `${limits.maxFilesPerRequest} files / request` },
                  { term: "CSS engine", detail: "PostCSS parse + patch" },
                ].map((item) => (
                  <div key={item.term}>
                    <dt className="text-2xs font-medium tracking-[0.12em] text-muted uppercase">{item.term}</dt>
                    <dd className="mt-1 font-mono text-xs text-ink-soft">{item.detail}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* Product preview — illustrative data, labelled as such */}
            <Panel className="relative overflow-hidden" padded={false}>
              <div className="grid-blueprint absolute inset-0 opacity-60" aria-hidden />
              <div className="relative">
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                  <span className="flex items-center gap-2 text-xs font-medium text-ink">
                    <Gauge className="size-3.5 text-accent" aria-hidden />
                    Image Optimizer — result summary
                  </span>
                  <StatusBadge tone="neutral">Sample data</StatusBadge>
                </div>
                <div className="grid grid-cols-3 divide-x divide-line border-b border-line">
                  {[
                    { label: "Input", value: formatBytes(SAMPLE_TOTAL_INPUT) },
                    { label: "Output", value: formatBytes(SAMPLE_TOTAL_OUTPUT) },
                    { label: "Saved", value: formatBytes(SAMPLE_SAVED), tone: "text-ok" },
                  ].map((cell) => (
                    <div key={cell.label} className="px-4 py-3.5">
                      <p className="text-2xs tracking-[0.1em] text-muted uppercase">{cell.label}</p>
                      <p className={`mt-1 font-mono text-sm tnum ${cell.tone ?? "text-ink"}`}>{cell.value}</p>
                    </div>
                  ))}
                </div>
                <TableShell minWidth={0}>
                  <thead>
                    <tr>
                      <Th>File</Th>
                      <Th numeric>Before</Th>
                      <Th numeric>After</Th>
                      <Th numeric>Saved</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {SAMPLE_ROWS.map((row) => (
                      <tr key={row.file}>
                        <Td mono>{row.file}</Td>
                        <Td numeric>{formatBytes(row.input)}</Td>
                        <Td numeric>{formatBytes(row.output)}</Td>
                        <Td numeric>
                          <span className="text-ok">
                            {formatBytes(row.input - row.output)}{" "}
                            <span className="text-muted">({formatSavingsPercent(((row.input - row.output) / row.input) * 100)})</span>
                          </span>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
                <p className="border-t border-line px-4 py-3 text-2xs leading-relaxed text-muted">
                  Illustrative values for three sample assets, not live measurements. Every number the app
                  reports comes from the buffers it actually produces.
                </p>
              </div>
            </Panel>
          </div>
        </section>

        {/* -------------------------------------------------------- capabilities */}
        <section className="border-b border-line">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Three tools, one workflow</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
              Each tool reports only what it can prove from the file you hand it.
            </p>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {[
                {
                  icon: ImageDown,
                  title: "Image Optimizer",
                  body: "Re-encode to WebP or AVIF, cap dimensions, and compare before/after previews with exact byte accounting.",
                  points: ["Real sharp pipeline", "Per-file status", "ZIP bundle export"],
                  href: "/app/images",
                  label: "Image Optimizer",
                },
                {
                  icon: FileCode2,
                  title: "Font Optimizer",
                  body: "Parse stylesheets with PostCSS, find @font-face rules missing font-display, and review a line-level diff before applying.",
                  points: ["Five policy options", "Malformed CSS reported", "Copy or download output"],
                  href: "/app/fonts",
                  label: "Font Optimizer",
                },
                {
                  icon: ScanSearch,
                  title: "Asset Analyzer",
                  body: "Inspect uploaded images and stylesheets for size, dimensions and format warnings, then send a file straight to the optimizer.",
                  points: ["Evidence per finding", "Thresholds from Settings", "Heuristics labelled"],
                  href: "/app/assets",
                  label: "Asset Analyzer",
                },
              ].map((card) => (
                <Panel key={card.title} className="flex flex-col">
                  <span className="grid size-9 place-items-center rounded-md border border-line bg-surface-sunken text-accent">
                    <card.icon className="size-4" aria-hidden />
                  </span>
                  <h3 className="mt-4 text-sm font-semibold text-ink">{card.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{card.body}</p>
                  <ul className="mt-4 flex flex-col gap-1.5">
                    {card.points.map((point) => (
                      <li key={point} className="flex items-center gap-2 text-xs text-ink-soft">
                        <Check className="size-3.5 shrink-0 text-ok" aria-hidden />
                        {point}
                      </li>
                    ))}
                  </ul>
                  <ButtonLink href={card.href} variant="secondary" size="sm" className="mt-5 self-start">
                    Open {card.label}
                  </ButtonLink>
                </Panel>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ workflow */}
        <section id="workflow" className="border-b border-line bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">How optimization works</h2>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
                  Select, configure, review. The same three steps for every asset.
                </p>
              </div>
              <p className="font-mono text-2xs tracking-[0.14em] text-muted uppercase">select → configure → review</p>
            </div>
            <ol className="mt-9 grid gap-px overflow-hidden border border-line bg-line md:grid-cols-3">
              {[
                {
                  step: "01",
                  title: "Select",
                  body: `Drop up to ${limits.maxFilesPerRequest} images or paste a stylesheet. Types are allowlisted and the real bytes are decoded before anything else happens.`,
                },
                {
                  step: "02",
                  title: "Configure",
                  body: "Pick an output format, set quality between 30 and 100, and optionally cap width or height. Aspect ratio is always preserved.",
                },
                {
                  step: "03",
                  title: "Review",
                  body: "Compare previews, read the measured input/output sizes and savings, then download single files or a bundled ZIP.",
                },
              ].map((item) => (
                <li key={item.step} className="bg-surface p-5">
                  <span className="font-mono text-2xs tracking-[0.16em] text-accent">{item.step}</span>
                  <h3 className="mt-3 text-sm font-semibold text-ink">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ------------------------------------------------ inputs & limitations */}
        <section className="border-b border-line">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-14 sm:px-6 lg:grid-cols-2">
            <div>
              <h2 className="text-xl font-semibold tracking-[-0.02em] text-ink">Supported inputs</h2>
              <div className="mt-4 flex flex-wrap gap-2">
                {["JPEG", "PNG", "WebP", "AVIF", "GIF", "TIFF", ".css"].map((format) => (
                  <FormatTag key={format}>{format}</FormatTag>
                ))}
              </div>
              <ul className="mt-5 flex flex-col gap-2.5 text-sm text-ink-soft">
                {[
                  `Up to ${Math.round(limits.maxFileBytes / (1024 * 1024))} MB per file and ${limits.maxFilesPerRequest} files per batch`,
                  "Quality range 30–100; dimensions capped at 8000px",
                  "Stylesheets up to 400,000 characters",
                  "SVG is analysed but not rasterised — it is already vector",
                ].map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="text-xl font-semibold tracking-[-0.02em] text-ink">Honest limitations</h2>
              <ul className="mt-4 flex flex-col gap-3 text-sm text-ink-soft">
                {[
                  "Savings are measured per file. They do not guarantee a better LCP, INP or CLS score — those depend on how the asset is used in the page.",
                  "The analyzer sees the file you upload, not your page. It cannot know the rendered size or the number of visitors.",
                  "Outputs larger than their source are reported as negative savings instead of being hidden.",
                  "History is scoped to this browser session. Artifacts expire after the configured retention period (30 days by default).",
                ].map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------- privacy */}
        <section className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-12 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex gap-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-md border border-line bg-surface-sunken text-accent">
                <Lock className="size-4" aria-hidden />
              </span>
              <div className="max-w-2xl">
                <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">Processing and privacy</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  Uploads are decoded in memory on the server and never executed. Results and metadata are
                  stored against an anonymous session cookie so you can revisit them during a working
                  session; produced files are pruned after {limits.artifactTtlHours} hours. No accounts, no
                  third-party trackers, no analytics beyond the session summary you can see yourself.
                </p>
              </div>
            </div>
            <ButtonLink href="/app/settings" variant="secondary" size="md">
              Review data retention
            </ButtonLink>
          </div>
        </section>

        {/* ----------------------------------------------------------- final CTA */}
        <section>
          <div className="mx-auto max-w-6xl px-4 py-16 text-center sm:px-6">
            <span className="mx-auto mb-6 flex w-fit items-center gap-2 font-mono text-2xs tracking-[0.16em] text-faint uppercase">
              <span className="inline-block h-[5px] w-10 rule-ticks" aria-hidden />
              Ready when you are
              <span className="inline-block h-[5px] w-10 rule-ticks" aria-hidden />
            </span>
            <h2 className="text-3xl font-semibold tracking-[-0.025em] text-ink">Make every byte count.</h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted">
              Start with a single image or a stylesheet you already ship. No sign-up, no configuration.
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <ButtonLink href="/app/images" variant="primary" size="lg" trailing={<ArrowRight className="size-4" aria-hidden />}>
                Open the optimizer
              </ButtonLink>
              <ButtonLink href="/app/fonts" variant="secondary" size="lg">
                Analyze CSS font-display
              </ButtonLink>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span className="flex items-center gap-2.5">
            <ProductMark size={20} />
            <span className="text-xs text-muted">OptiWeb Studio — static asset performance toolkit</span>
          </span>
          <p className="font-mono text-2xs text-faint">sharp · postcss · react · node</p>
        </div>
      </footer>
    </div>
  );
}
