import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, FileCode2, Globe, ImageDown, ScanSearch, ShieldCheck } from "lucide-react";
import { WorkspaceShell } from "@/components/layout/WorkspaceShell";
import { ButtonLink } from "@/components/ui/Button";
import { PageHeader, Panel, PanelHeader, StatStrip } from "@/components/ui/Layout";
import { ImageOptimizer } from "@/features/images/ImageOptimizer";
import { FontOptimizer } from "@/features/fonts/FontOptimizer";
import { AssetAnalyzer } from "@/features/assets/AssetAnalyzer";
import { WebsiteAudit } from "@/features/audit/WebsiteAudit";
import { SettingsForm } from "@/features/settings/SettingsForm";
import { formatBytes, formatNumber, formatSavingsPercent } from "@/lib/format";
import { usePreferences } from "@/lib/preferences";
import { useSessionActivity } from "@/lib/session-activity";

function PageFrame({ title, context, eyebrow, description, maxWidth = "max-w-6xl", actions, children }: {
  title: string; context: string; eyebrow: string; description: string; maxWidth?: string; actions?: ReactNode; children: ReactNode;
}) {
  return (
    <WorkspaceShell title={title} context={context} actions={actions}>
      <div className={`mx-auto flex ${maxWidth} flex-col gap-6`}>
        <PageHeader eyebrow={eyebrow} title={title} description={description} />
        {children}
      </div>
    </WorkspaceShell>
  );
}

export function ImagePage() {
  return (
    <PageFrame
      title="Image Optimizer"
      context="Convert, compress and compare, inside this browser tab"
      eyebrow="Tool"
      description="Reduce image weight while keeping the visual quality you need. Your images are processed on this device and are not uploaded."
      actions={<ButtonLink href="/app/assets" variant="secondary" size="sm">Analyze first</ButtonLink>}
    >
      <ImageOptimizer />
    </PageFrame>
  );
}

export function FontsPage() {
  const preferences = usePreferences();
  return (
    <PageFrame
      title="Font Optimizer"
      context="PostCSS analysis and safe font-display patching, in this browser"
      eyebrow="Tool"
      description="Find @font-face rules that lack font-display, review the exact changes, and download the patched stylesheet."
    >
      <FontOptimizer initialPolicy={preferences.fontDisplayPolicy} />
    </PageFrame>
  );
}

export function AssetsPage() {
  const preferences = usePreferences();
  return (
    <PageFrame
      title="Asset Analyzer"
      context="Evidence-based diagnostics for files on this device"
      eyebrow="Diagnostic"
      description="Inspect image weight, dimensions, metadata and CSS font-loading gaps before converting anything."
    >
      <AssetAnalyzer thresholdKb={preferences.analyzerThresholdKb} />
    </PageFrame>
  );
}

export function AuditPage() {
  return (
    <PageFrame
      title="Website Performance Audit"
      context="Document-level inspection of a public URL"
      eyebrow="Lab measurement"
      description="Inspect a public page and the resources it names. Browser-rendered and field metrics are reported only when a real measurement source provides them."
    >
      <WebsiteAudit />
    </PageFrame>
  );
}

export function SettingsPage() {
  return (
    <PageFrame title="Settings" context="Kept in this browser" eyebrow="Preferences" description="Choose the defaults the tools start from. Settings are stored in this browser only." maxWidth="max-w-5xl">
      <SettingsForm />
    </PageFrame>
  );
}

const TOOLS = [
  { title: "Image Optimizer", desc: "Convert to WebP, AVIF, JPEG or PNG and compare real output bytes.", href: "/app/images", icon: ImageDown, where: "runs in this browser" },
  { title: "Font Optimizer", desc: "Find and patch @font-face rules that lack font-display.", href: "/app/fonts", icon: FileCode2, where: "runs in this browser" },
  { title: "Asset Analyzer", desc: "Read dimensions, weight and metadata from file headers.", href: "/app/assets", icon: ScanSearch, where: "runs in this browser" },
  { title: "Website Audit", desc: "Inspect a public page and the assets it names.", href: "/app/audit", icon: Globe, where: "the server fetches the URL" },
] as const;

export function OverviewPage() {
  const activity = useSessionActivity();
  const images = activity.images;
  const used = images.runs + activity.fonts.runs + activity.assets.runs + activity.audit.runs > 0;
  const saved = images.inputBytes - images.outputBytes;
  return (
    <WorkspaceShell title="Overview" context="Web-asset tools that run in your browser" actions={<ButtonLink href="/app/images" variant="primary" size="sm" leading={<ImageDown className="size-3.5" aria-hidden />}>Optimize images</ButtonLink>}>
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <PageHeader eyebrow="Workspace" title="Your files stay on this device." description="Image conversion, font-loading checks and asset diagnostics, carried out by your browser. Nothing you select is uploaded." />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {TOOLS.map((item) => (
            <Link key={item.href} to={item.href} className="group border border-line bg-surface p-5 transition-colors hover:border-accent-border hover:bg-surface-sunken/40">
              <div className="flex items-center justify-between">
                <span className="grid size-10 place-items-center border border-line bg-surface-sunken text-accent">
                  <item.icon className="size-5" aria-hidden />
                </span>
                <ArrowRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden />
              </div>
              <h2 className="mt-4 text-base font-semibold text-ink">{item.title}</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted">{item.desc}</p>
              <p className="mt-3 font-mono text-2xs tracking-wide text-muted uppercase">{item.where}</p>
            </Link>
          ))}
        </div>

        <Panel labelledBy="how-it-works">
          <div className="flex gap-3.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-md border border-line bg-surface-sunken text-accent">
              <ShieldCheck className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 id="how-it-works" className="text-sm font-semibold text-ink">How your files are handled</h2>
              <ol className="mt-2 grid gap-3 text-xs leading-relaxed text-muted md:grid-cols-3">
                <li><span className="font-medium text-ink">1. You select a file.</span> The browser gives this page access to it. The page checks its contents and reads its header.</li>
                <li><span className="font-medium text-ink">2. The browser does the work.</span> Decoding, resizing, encoding and CSS parsing run on this device, in a Web Worker of this tab.</li>
                <li><span className="font-medium text-ink">3. You save the result.</span> It is written from this tab's memory to your downloads. Leaving the page discards everything.</li>
              </ol>
              <p className="mt-3 max-w-3xl text-xs leading-relaxed text-muted">
                The server behind this site has no endpoint that accepts a file, no database and no file storage, and the site sets no cookies. Only the
                Website Audit talks to the server: it sends the URL you ask it to inspect.
              </p>
            </div>
          </div>
        </Panel>

        <Panel labelledBy="this-visit">
          <PanelHeader id="this-visit" title="This visit" description="Counted in this tab since the page was loaded. Nothing is recorded: a reload starts again from zero." />
          <StatStrip
            items={[
              { label: "Images processed", value: formatNumber(images.items), hint: `${images.runs} run${images.runs === 1 ? "" : "s"}` },
              { label: "Bytes saved", value: images.items > 0 ? formatBytes(saved) : "—", hint: images.inputBytes > 0 ? formatSavingsPercent(Math.round((saved / images.inputBytes) * 1000) / 10) : "measured from real output" },
              { label: "Stylesheets and files analysed", value: formatNumber(activity.fonts.items + activity.assets.items) },
              { label: "Pages audited", value: formatNumber(activity.audit.items) },
            ]}
          />
          {!used ? <p className="mt-4 text-sm text-muted">Nothing yet. Start with a tool above.</p> : null}
        </Panel>
      </div>
    </WorkspaceShell>
  );
}

export function NotFoundPage() {
  return (
    <main id="main" className="grid min-h-screen place-items-center bg-canvas px-4">
      <Panel className="w-full max-w-lg text-center">
        <p className="font-mono text-xs tracking-[0.16em] text-muted uppercase">404 · Not found</p>
        <h1 className="mt-3 text-2xl font-semibold text-ink">This page does not exist</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">The address may be mistyped, or the page may have been part of an earlier version.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <ButtonLink href="/app" variant="primary">Open the workspace</ButtonLink>
          <ButtonLink href="/" variant="secondary">Home</ButtonLink>
        </div>
      </Panel>
    </main>
  );
}

/** Pages of earlier versions that kept records on a server. They explain what changed instead of failing. */
export function RetiredPage({ title }: { title: string }) {
  return (
    <PageFrame title={title} context="No longer part of the app" eyebrow="Removed" description="This page listed records that an earlier version kept on a server." maxWidth="max-w-3xl">
      <Panel>
        <h2 className="text-sm font-semibold text-ink">Nothing is stored any more</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          The tools now run in your browser and keep no record of your files, so there is no history and no stored result to show. Results are available
          on the tool's page until you leave it.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <ButtonLink href="/app/images" variant="primary">Optimize images</ButtonLink>
          <ButtonLink href="/app" variant="secondary">Overview</ButtonLink>
        </div>
      </Panel>
    </PageFrame>
  );
}
