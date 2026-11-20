import { useEffect } from "react";
import { ArrowRight, Check, FileCode2, Gauge, Globe, ImageDown, MonitorSmartphone, ScanSearch, ServerOff, ShieldCheck } from "lucide-react";
import { ButtonLink } from "@/components/ui/Button";
import { ProductMark, Wordmark } from "@/components/brand/ProductMark";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { FormatTag, Panel, TableShell, Td, Th } from "@/components/ui/Layout";
import { StatusBadge } from "@/components/ui/Feedback";
import { formatBytes, formatSavingsPercent } from "@/lib/format";

export const LANDING_TITLE = "Unikit Studio — Image and web-asset tools that run in your browser";

/**
 * Illustrative sample used in the product preview. It is clearly labelled as
 * sample data: it is not a benchmark claim and not live user data.
 */
const SAMPLE_ROWS = [
  { file: "hero-header.jpg", input: 842_112, output: 214_880, format: "webp" },
  { file: "team-portrait.jpg", input: 512_004, output: 148_772, format: "webp" },
  { file: "diagram-scheme.png", input: 268_144, output: 61_470, format: "webp" },
];

const SAMPLE_TOTAL_INPUT = SAMPLE_ROWS.reduce((sum, row) => sum + row.input, 0);
const SAMPLE_TOTAL_OUTPUT = SAMPLE_ROWS.reduce((sum, row) => sum + row.output, 0);
const SAMPLE_SAVED = SAMPLE_TOTAL_INPUT - SAMPLE_TOTAL_OUTPUT;

const TOOLS = [
  {
    icon: ImageDown,
    title: "Image Optimizer",
    body: "Re-encode to WebP, AVIF, JPEG or PNG, cap dimensions, and compare before and after with exact byte counts.",
    points: ["Runs in a Web Worker of your tab", "Per-file status, cancel at any time", "ZIP built on your device"],
    href: "/app/images",
  },
  {
    icon: FileCode2,
    title: "Font Optimizer",
    body: "Parse a stylesheet with PostCSS, find @font-face rules without font-display, and review a line-level diff before applying.",
    points: ["Five policy options", "Malformed CSS reported, never patched", "Copy or download the output"],
    href: "/app/fonts",
  },
  {
    icon: ScanSearch,
    title: "Asset Analyzer",
    body: "Read format, dimensions, weight and metadata straight from file headers, then send a file to the optimizer.",
    points: ["Evidence for every finding", "Flags GPS location in photos", "Heuristics labelled as such"],
    href: "/app/assets",
  },
  {
    icon: Globe,
    title: "Website Audit",
    body: "Inspect a public page and the images, stylesheets, fonts and scripts it names. The one tool that needs the server.",
    points: ["Sends a URL, never a file", "Private addresses are refused", "Lab data labelled as lab data"],
    href: "/app/audit",
  },
] as const;

export default function LandingPage() {
  useEffect(() => {
    document.title = LANDING_TITLE;
  }, []);

  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Wordmark tagline={false} />
          <nav aria-label="Product" className="flex items-center gap-2">
            <ThemeToggle />
            <ButtonLink href="/app" variant="ghost" size="sm" className="max-sm:hidden">
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
                Web-asset toolkit · runs in your browser
              </p>
              <h1 className="mt-5 text-display font-semibold tracking-[-0.03em] text-ink">
                Lighter assets.
                <br />
                Nothing uploaded.
              </h1>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-soft">
                Convert images, check font-loading rules and inspect assets in one focused workspace. Your browser does the work, so your files
                stay on your device.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <ButtonLink href="/app/images" variant="primary" size="lg" trailing={<ArrowRight className="size-4" aria-hidden />}>
                  Open the optimizer
                </ButtonLink>
                <ButtonLink href="#privacy" variant="secondary" size="lg">
                  How your files are handled
                </ButtonLink>
              </div>
              <dl className="mt-9 grid max-w-lg grid-cols-3 gap-4 border-t border-line pt-5">
                {[
                  { term: "Formats", detail: "WebP · AVIF · JPEG · PNG" },
                  { term: "Processing", detail: "on your device" },
                  { term: "Account", detail: "none · no cookies" },
                ].map((item) => (
                  <div key={item.term}>
                    <dt className="text-2xs font-medium tracking-[0.12em] text-muted uppercase">{item.term}</dt>
                    <dd className="mt-1 font-mono text-xs text-ink-soft">{item.detail}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* Product preview: illustrative data, labelled as such */}
            <Panel className="relative overflow-hidden" padded={false}>
              <div className="grid-blueprint absolute inset-0 opacity-60" aria-hidden />
              <div className="relative">
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                  <span className="flex items-center gap-2 text-xs font-medium text-ink">
                    <Gauge className="size-3.5 text-accent" aria-hidden />
                    Image Optimizer · result summary
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
                  Illustrative values for three sample assets, not live measurements. Every number the app reports is the real size of a file your
                  browser produced.
                </p>
              </div>
            </Panel>
          </div>
        </section>

        {/* -------------------------------------------------------- capabilities */}
        <section className="border-b border-line">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Four tools, one workspace</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">Each tool reports only what it can show from the file or page you give it.</p>
            <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {TOOLS.map((card) => (
                <Panel key={card.title} className="flex flex-col">
                  <span className="grid size-9 place-items-center rounded-md border border-line bg-surface-sunken text-accent">
                    <card.icon className="size-4" aria-hidden />
                  </span>
                  <h3 className="mt-4 text-sm font-semibold text-ink">{card.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{card.body}</p>
                  <ul className="mt-4 flex flex-col gap-1.5">
                    {card.points.map((point) => (
                      <li key={point} className="flex items-start gap-2 text-xs text-ink-soft">
                        <Check className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden />
                        {point}
                      </li>
                    ))}
                  </ul>
                  <ButtonLink href={card.href} variant="secondary" size="sm" className="mt-5 self-start">
                    Open {card.title}
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
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">Select, configure, review. The same three steps for every image, all of them on your device.</p>
              </div>
              <p className="font-mono text-2xs tracking-[0.14em] text-muted uppercase">select · configure · review</p>
            </div>
            <ol className="mt-9 grid gap-px overflow-hidden border border-line bg-line md:grid-cols-3">
              {[
                {
                  step: "01",
                  title: "Select",
                  body: "Drop images onto the page. Each file is identified from its own bytes, and its header is read for dimensions before anything is decoded.",
                },
                {
                  step: "02",
                  title: "Configure",
                  body: "Pick an output format or let the tool compare several, set the quality, and optionally cap width or height. Proportions are always kept.",
                },
                {
                  step: "03",
                  title: "Review",
                  body: "Compare previews and read the measured sizes. When a result is larger than its original, you are told, and the original is offered instead.",
                },
              ].map((item) => (
                <li key={item.step} className="bg-surface p-5">
                  <span className="font-mono text-2xs tracking-[0.16em] text-accent">{item.step}</span>
                  <h3 className="mt-3 text-sm font-semibold text-ink">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
                </li>
              ))}
            </ol>
            <div className="mt-8 flex flex-wrap items-center gap-2">
              <span className="mr-1 text-xs text-muted">Reads</span>
              {["JPEG", "PNG", "WebP", "AVIF", "GIF", "BMP", ".css"].map((format) => (
                <FormatTag key={format}>{format}</FormatTag>
              ))}
              <span className="mx-1 text-xs text-muted">· writes</span>
              {["WebP", "AVIF", "JPEG", "PNG"].map((format) => (
                <FormatTag key={`out-${format}`}>{format}</FormatTag>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------- privacy */}
        <section id="privacy" className="border-b border-line">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <div className="flex gap-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-md border border-line bg-surface-sunken text-accent">
                <ShieldCheck className="size-4" aria-hidden />
              </span>
              <div className="max-w-2xl">
                <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Private because of how it is built</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  The tools do not promise to delete your files after processing them. They never receive them. The work is done by your browser,
                  and the server has nothing that could take a file.
                </p>
              </div>
            </div>
            <div className="mt-8 grid gap-4 lg:grid-cols-2">
              <Panel>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <MonitorSmartphone className="size-4 text-accent" aria-hidden />
                  On your device
                </h3>
                <ul className="mt-3 flex flex-col gap-2.5 text-sm text-ink-soft">
                  {[
                    "Images are decoded, resized and encoded by your browser, in a Web Worker of the tab.",
                    "Stylesheets are parsed and patched in the page. Asset analysis reads file headers in the page.",
                    "Results live in the tab's memory. Downloads and ZIP files are made there, without a request.",
                    "Closing the tab or leaving the page discards everything. Nothing is written to disk except what you save.",
                  ].map((item) => (
                    <li key={item} className="flex gap-2.5">
                      <Check className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden />
                      {item}
                    </li>
                  ))}
                </ul>
              </Panel>
              <Panel>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <ServerOff className="size-4 text-accent" aria-hidden />
                  On the server
                </h3>
                <ul className="mt-3 flex flex-col gap-2.5 text-sm text-ink-soft">
                  {[
                    "No endpoint accepts a file. There is no upload route to send one to.",
                    "No database and no file storage: there is nowhere a result could be kept.",
                    "No cookies, no accounts, no analytics and no third-party scripts.",
                    "One job only: the Website Audit fetches the public URL you enter and returns a report, which is not kept.",
                  ].map((item) => (
                    <li key={item} className="flex gap-2.5">
                      <Check className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden />
                      {item}
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border border-line bg-surface px-4 py-4 sm:px-5">
              <p className="max-w-3xl text-sm leading-relaxed text-muted">
                <span className="font-medium text-ink">You can check this yourself.</span> Open your browser's developer tools on the Network tab
                and optimize an image: the only requests are for the app's own code, including the AVIF codec the first time it is needed. The
                site's Content-Security-Policy also tells the browser to refuse any connection to another origin.
              </p>
              <ButtonLink href="/app/settings" variant="secondary" size="md">
                What is kept in your browser
              </ButtonLink>
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------------- final CTA */}
        <section>
          <div className="mx-auto max-w-6xl px-4 py-16 text-center sm:px-6">
            <span className="mx-auto mb-6 flex w-fit items-center gap-2 font-mono text-2xs tracking-[0.16em] text-muted uppercase">
              <span className="inline-block h-[5px] w-10 rule-ticks" aria-hidden />
              Ready when you are
              <span className="inline-block h-[5px] w-10 rule-ticks" aria-hidden />
            </span>
            <h2 className="text-3xl font-semibold tracking-[-0.025em] text-ink">Optimize here. Upload nothing.</h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted">Start with a single image or a stylesheet you already ship. No sign-up, no configuration.</p>
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
            <span className="text-xs text-muted">Unikit Studio · web-asset tools that run in your browser</span>
          </span>
          <p className="font-mono text-2xs text-muted">canvas · webassembly · postcss · react</p>
        </div>
      </footer>
    </div>
  );
}
