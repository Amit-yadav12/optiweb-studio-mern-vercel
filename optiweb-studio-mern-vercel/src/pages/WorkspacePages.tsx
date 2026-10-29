import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowRight, FileCode2, Globe, ImageDown, Search, ScanSearch } from "lucide-react";
import { WorkspaceShell } from "@/components/layout/WorkspaceShell";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState, ErrorState, ProgressIndicator, StatusBadge } from "@/components/ui/Feedback";
import { PageHeader, Panel, PanelHeader, StatStrip, TableShell, Td, Th } from "@/components/ui/Layout";
import { ImageOptimizer } from "@/features/images/ImageOptimizer";
import { FontOptimizer } from "@/features/fonts/FontOptimizer";
import { AssetAnalyzer } from "@/features/assets/AssetAnalyzer";
import { WebsiteAudit } from "@/features/audit/WebsiteAudit";
import { SettingsForm } from "@/features/settings/SettingsForm";
import { api } from "@/lib/api-client";
import { formatBytes, formatNumber, formatRelativeTime } from "@/lib/format";
import { statusToneFor } from "@/lib/status";
import type { HistoryEntry, HistoryPage as HistoryPageData, Preferences } from "@/types/domain";

const FALLBACK_PREFS: Preferences = {
  defaultImageFormat: "webp", defaultQuality: 78, defaultMaxWidth: null,
  fontDisplayPolicy: "swap", analyzerThresholdKb: 300, reduceMotion: false, updatedAt: null,
};

type LimitsResponse = { maxFileBytes: number; maxFilesPerRequest: number; maxDecodedPixels: number; artifactTtlHours: number };

function useLimits() {
  const [limits, setLimits] = useState<LimitsResponse>({ maxFileBytes: 1_000_000, maxFilesPerRequest: 4, maxDecodedPixels: 24_000_000, artifactTtlHours: 720 });
  useEffect(() => { api.get<LimitsResponse>("/api/v1/limits").then(setLimits).catch(() => undefined); }, []);
  return limits;
}

function usePreferences() {
  const [prefs, setPrefs] = useState<Preferences>(FALLBACK_PREFS);
  useEffect(() => { api.get<Preferences>("/api/v1/preferences").then(setPrefs).catch(() => undefined); }, []);
  return prefs;
}

function PageFrame({ title, context, eyebrow, description, maxWidth = "max-w-6xl", actions, children }: {
  title: string; context: string; eyebrow: string; description: string; maxWidth?: string; actions?: ReactNode; children: ReactNode;
}) {
  return <WorkspaceShell title={title} context={context} actions={actions}>
    <div className={`mx-auto flex ${maxWidth} flex-col gap-6`}>
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      {children}
    </div>
  </WorkspaceShell>;
}

export function ImagePage() {
  const limits = useLimits();
  return <PageFrame title="Image Optimizer" context="Convert, compress and compare — measured from real output" eyebrow="Tool" description="Reduce image weight while preserving the visual quality you need." actions={<ButtonLink href="/app/history" variant="secondary" size="sm">Past results</ButtonLink>}>
    <ImageOptimizer limits={{ maxFileMb: Math.max(1, Math.floor(limits.maxFileBytes / 1024 / 1024)), maxFiles: limits.maxFilesPerRequest, maxDecodedPixels: limits.maxDecodedPixels }} />
  </PageFrame>;
}

export function FontsPage() {
  const prefs = usePreferences();
  return <PageFrame title="Font Optimizer" context="PostCSS analysis and safe font-display patching" eyebrow="Tool" description="Find @font-face rules that lack font-display, review the exact changes, and download the patched stylesheet." maxWidth="max-w-7xl">
    <FontOptimizer initialPolicy={prefs.fontDisplayPolicy} />
  </PageFrame>;
}

export function AssetsPage() {
  const limits = useLimits();
  const prefs = usePreferences();
  return <PageFrame title="Asset Analyzer" context="Evidence-based diagnostics for uploaded files" eyebrow="Diagnostic" description="Inspect image weight, dimensions and CSS font-loading gaps before converting anything." maxWidth="max-w-5xl">
    <AssetAnalyzer defaults={{ thresholdKb: prefs.analyzerThresholdKb, maxFileMb: Math.max(1, Math.floor(limits.maxFileBytes / 1024 / 1024)), maxFiles: limits.maxFilesPerRequest }} />
  </PageFrame>;
}

export function AuditPage() {
  return <PageFrame title="Website Performance Audit" context="Document-level inspection of a public URL" eyebrow="Lab measurement" description="Inspect a public page and discover linked resources. Browser-rendered and field metrics are only included when the configured provider supplies them.">
    <WebsiteAudit />
  </PageFrame>;
}

export function SettingsPage() {
  const prefs = usePreferences();
  return <PageFrame title="Settings" context="Guest session preferences" eyebrow="Preferences" description="Choose optimizer defaults and review the limits enforced by this deployment." maxWidth="max-w-5xl">
    <SettingsForm defaults={prefs} />
  </PageFrame>;
}

function useHistoryData(query: string) {
  const [data, setData] = useState<(HistoryPageData & { summary?: { jobs: number; savedBytes: number; inputBytes: number; files: number; completed: number } }) | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try { setData(await api.get(`/api/v1/history${query ? `?${query}` : ""}`)); }
    catch (err) { setError(err instanceof Error ? err.message : "History could not be loaded."); }
    finally { setBusy(false); }
  }, [query]);
  useEffect(() => { void load(); }, [load]);
  return { data, busy, error, reload: load };
}

const KIND_LABEL: Record<string, string> = { "image.optimize": "Images", "css.font-display": "CSS", "asset.analyze": "Analysis", "site.audit": "Audit" };
const KIND_ICON: Record<string, typeof ImageDown> = { "image.optimize": ImageDown, "css.font-display": FileCode2, "asset.analyze": ScanSearch, "site.audit": Globe };

export function OverviewPage() {
  const { data, busy, error } = useHistoryData("page=1&pageSize=6");
  const summary = data?.summary;
  return <WorkspaceShell title="Overview" context="Your optimization workspace" actions={<ButtonLink href="/app/images" variant="primary" size="sm" leading={<ImageDown className="size-3.5" />}>New optimization</ButtonLink>}>
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader eyebrow="Workspace" title="Make every byte count." description="A focused workspace for image conversion, font-loading checks, and evidence-based asset diagnostics." />
      <div className="grid gap-3 md:grid-cols-3">
        {[{ title: "Image Optimizer", desc: "Convert and compare real output bytes.", href: "/app/images", icon: ImageDown }, { title: "Font Optimizer", desc: "Inspect and patch font-display rules.", href: "/app/fonts", icon: FileCode2 }, { title: "Website Audit", desc: "Inspect discoverable assets on a public page.", href: "/app/audit", icon: Globe }].map((item) => <Link key={item.href} to={item.href} className="group border border-line bg-surface p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-accent-border hover:shadow-raise focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <div className="flex items-center justify-between"><span className="grid size-10 place-items-center border border-line bg-surface-sunken text-accent"><item.icon className="size-5" /></span><ArrowRight className="size-4 text-muted transition-transform group-hover:translate-x-0.5" /></div>
          <h2 className="mt-4 text-base font-semibold text-ink">{item.title}</h2><p className="mt-1 text-sm leading-relaxed text-muted">{item.desc}</p>
        </Link>)}
      </div>
      <Panel>
        <PanelHeader title="Your activity" description="Metrics are based on jobs stored in this browser session." actions={<ButtonLink href="/app/history" variant="secondary" size="sm">View history</ButtonLink>} />
        {error ? <ErrorState title="History unavailable" message={error} hint="Core tools can still work, but persistence requires MongoDB configuration." /> : busy ? <ProgressIndicator label="Loading your session history…" /> : <>
          <StatStrip items={[{ label: "Jobs", value: formatNumber(summary?.jobs ?? 0) }, { label: "Files", value: formatNumber(summary?.files ?? 0) }, { label: "Bytes saved", value: formatBytes(summary?.savedBytes ?? 0) }]} />
          {data?.entries.length ? <div className="mt-5"><HistoryTable entries={data.entries} /></div> : <div className="mt-5"><EmptyState title="No optimization jobs yet" description="Your completed image, CSS, asset, and audit jobs will appear here." action={<ButtonLink href="/app/images" variant="primary" size="sm">Optimize your first image</ButtonLink>} /></div>}
        </>}
      </Panel>
    </div>
  </WorkspaceShell>;
}

function HistoryTable({ entries }: { entries: HistoryEntry[] }) {
  return <TableShell>
    <thead><tr><Th>Job</Th><Th>Type</Th><Th>Status</Th><Th>Created</Th><Th numeric>Saved</Th><Th /></tr></thead>
    <tbody>{entries.map((entry) => { const Icon = KIND_ICON[entry.kind] ?? FileCode2; return <tr key={entry.id}>
      <Td><Link to={`/app/history/${entry.id}`} className="flex items-center gap-2 font-medium text-ink hover:text-accent"><Icon className="size-4 shrink-0 text-muted" /><span className="truncate">{entry.label}</span></Link></Td>
      <Td>{KIND_LABEL[entry.kind] ?? entry.kind}</Td><Td><StatusBadge tone={statusToneFor(entry.status)}>{entry.status}</StatusBadge></Td>
      <Td>{formatRelativeTime(entry.createdAt)}</Td><Td numeric><span className={entry.savedBytes > 0 ? "text-ok" : "text-muted"}>{formatBytes(entry.savedBytes)}</span></Td><Td><Link className="text-xs font-medium text-accent hover:underline" to={`/app/history/${entry.id}`}>Details</Link></Td>
    </tr>; })}</tbody>
  </TableShell>;
}

export function HistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [kind, setKind] = useState(searchParams.get("kind") ?? "all");
  const [status, setStatus] = useState(searchParams.get("status") ?? "all");
  const query = new URLSearchParams();
  if (searchParams.get("q")) query.set("q", searchParams.get("q")!);
  if (kind !== "all") query.set("kind", kind);
  if (status !== "all") query.set("status", status);
  query.set("page", searchParams.get("page") ?? "1"); query.set("pageSize", "10");
  const { data, busy, error, reload } = useHistoryData(query.toString());
  const applyFilters = () => setSearchParams((previous) => { const next = new URLSearchParams(previous); if (search.trim()) next.set("q", search.trim()); else next.delete("q"); if (kind !== "all") next.set("kind", kind); else next.delete("kind"); if (status !== "all") next.set("status", status); else next.delete("status"); next.delete("page"); return next; });
  const clear = async () => { if (!window.confirm("Clear all history and stored artifacts for this session? This cannot be undone.")) return; try { await api.del("/api/v1/history"); await reload(); } catch (err) { window.alert(err instanceof Error ? err.message : "History could not be cleared."); } };
  return <PageFrame title="History" context="Previously completed jobs in this session" eyebrow="Records" description="Search and review measured results from your optimization jobs." maxWidth="max-w-7xl" actions={<Button variant="secondary" size="sm" onClick={clear}>Clear history</Button>}>
    <Panel>
      <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_180px_180px_auto] md:items-end">
        <div><label className="mb-1.5 block text-xs font-medium text-ink-soft" htmlFor="history-search">Search jobs</label><div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" /><input id="history-search" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyFilters(); }} placeholder="Search by job name" className="h-10 w-full border border-line-strong bg-surface pl-9 pr-3 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/15" /></div></div>
        <div><label className="mb-1.5 block text-xs font-medium text-ink-soft" htmlFor="history-kind">Job type</label><select id="history-kind" value={kind} onChange={(event) => setKind(event.target.value)} className="h-10 w-full border border-line-strong bg-surface px-3 text-sm text-ink"><option value="all">All types</option><option value="image.optimize">Images</option><option value="css.font-display">CSS</option><option value="asset.analyze">Analysis</option><option value="site.audit">Audit</option></select></div>
        <div><label className="mb-1.5 block text-xs font-medium text-ink-soft" htmlFor="history-status">Status</label><select id="history-status" value={status} onChange={(event) => setStatus(event.target.value)} className="h-10 w-full border border-line-strong bg-surface px-3 text-sm text-ink"><option value="all">All statuses</option><option value="completed">Completed</option><option value="partial">Partial</option><option value="failed">Failed</option></select></div>
        <Button variant="primary" onClick={applyFilters}>Apply</Button>
      </div>
      <div className="mt-5">{error ? <ErrorState title="Could not load history" message={error} /> : busy ? <ProgressIndicator label="Loading history…" /> : data?.entries.length ? <HistoryTable entries={data.entries} /> : <EmptyState title="Nothing matches these filters" description="Try another search or run a new optimization." action={<ButtonLink href="/app/images" variant="secondary" size="sm">Optimize an image</ButtonLink>} />}</div>
      {data && data.pageCount > 1 ? <div className="mt-4 flex items-center justify-between border-t border-line pt-4"><span className="text-xs text-muted">Page {data.page} of {data.pageCount} · {data.total} jobs</span><div className="flex gap-2"><Button disabled={data.page <= 1} variant="secondary" size="sm" onClick={() => setSearchParams((old) => { const p = new URLSearchParams(old); p.set("page", String(data.page - 1)); return p; })}>Previous</Button><Button disabled={data.page >= data.pageCount} variant="secondary" size="sm" onClick={() => setSearchParams((old) => { const p = new URLSearchParams(old); p.set("page", String(data.page + 1)); return p; })}>Next</Button></div></div> : null}
    </Panel>
  </PageFrame>;
}

export function HistoryDetailPage() {
  const { id = "" } = useParams();
  const [data, setData] = useState<{ job: { id: string; kind: string; status: string; label: string; fileCount: number; inputBytes: number; outputBytes: number; savedBytes: number; note: string | null; createdAt: string }; items: Array<{ id: string; filename: string; outputFilename: string | null; status: string; inputBytes: number; outputBytes: number; savedBytes: number; outputFormat: string | null; message: string | null; hasArtifact: boolean }> } | null>(null);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(true);
  useEffect(() => { let active = true; setBusy(true); api.get<typeof data>(`/api/v1/history/${id}`).then((result) => { if (active) setData(result); }).catch((err) => { if (active) setError(err instanceof Error ? err.message : "Could not load job."); }).finally(() => { if (active) setBusy(false); }); return () => { active = false; }; }, [id]);
  const remove = async () => { if (!window.confirm("Delete this job and its stored artifacts?")) return; try { await api.del(`/api/v1/history/${id}`); window.location.href = "/app/history"; } catch (err) { setError(err instanceof Error ? err.message : "Could not delete job."); } };
  return <PageFrame title="Job details" context="Stored optimization record" eyebrow="History" description="Inspect the metadata and artifact availability recorded for this job." maxWidth="max-w-5xl" actions={<ButtonLink href="/app/history" variant="secondary" size="sm">Back to history</ButtonLink>}>
    {error ? <ErrorState title="Job unavailable" message={error} hint="The record may have expired, been deleted, or belong to another session." /> : busy ? <ProgressIndicator label="Loading job details…" /> : data ? <>
      <Panel><PanelHeader title={data.job.label} description={`Created ${new Date(data.job.createdAt).toLocaleString()}`} actions={<StatusBadge tone={statusToneFor(data.job.status)}>{data.job.status}</StatusBadge>} />
        <StatStrip items={[{ label: "Files", value: formatNumber(data.job.fileCount) }, { label: "Input", value: formatBytes(data.job.inputBytes) }, { label: "Output", value: formatBytes(data.job.outputBytes) }, { label: "Bytes saved", value: formatBytes(data.job.savedBytes) }]} />
        {data.job.note ? <p className="mt-4 text-sm text-muted">{data.job.note}</p> : null}
      </Panel>
      <Panel><PanelHeader title="Processed items" description="Downloads are available while their artifacts remain in storage." />
        <TableShell><thead><tr><Th>File</Th><Th>Status</Th><Th>Format</Th><Th numeric>Before</Th><Th numeric>After</Th><Th numeric>Saved</Th><Th>Output</Th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><Td>{item.filename}</Td><Td><StatusBadge tone={statusToneFor(item.status)}>{item.status}</StatusBadge></Td><Td>{item.outputFormat ?? "—"}</Td><Td numeric>{formatBytes(item.inputBytes)}</Td><Td numeric>{formatBytes(item.outputBytes)}</Td><Td numeric>{formatBytes(item.savedBytes)}</Td><Td>{item.hasArtifact ? <a className="text-xs font-medium text-accent hover:underline" href={`/api/v1/artifacts/${item.id}?download=1`}>Download</a> : <span className="text-xs text-muted">Unavailable</span>}</Td></tr>)}</tbody></TableShell>
      </Panel>
      <div className="flex flex-wrap gap-2"><Button variant="danger" onClick={remove}>Delete job</Button><ButtonLink href="/app/images" variant="primary">Optimize another image</ButtonLink></div>
    </> : null}
  </PageFrame>;
}

export function NotFoundPage() {
  return <div className="grid min-h-screen place-items-center bg-canvas px-4"><Panel className="w-full max-w-lg text-center"><p className="font-mono text-xs uppercase tracking-[0.16em] text-muted">404 · Not found</p><h1 className="mt-3 text-2xl font-semibold text-ink">This page is not here.</h1><p className="mt-2 text-sm text-muted">The page may have moved or the link may be incorrect.</p><ButtonLink className="mt-5" href="/app" variant="primary">Return to workspace</ButtonLink></Panel></div>;
}
