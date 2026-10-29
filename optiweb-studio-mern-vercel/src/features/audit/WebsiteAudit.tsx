import { useState } from "react";
import { Globe, Info } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ErrorState, ProgressIndicator, StatusBadge, useToast } from "@/components/ui/Feedback";
import { Field, Input } from "@/components/ui/Form";
import { Panel, PanelHeader, StatStrip, TableShell, Td, Th } from "@/components/ui/Layout";
import { ApiClientError, api } from "@/lib/api-client";
import { formatBytes } from "@/lib/format";

type AuditResponse = {
  url: string;
  fetchedUrl: string;
  durationMs: number;
  coverage: { mode: string; javascriptRendered: boolean; note: string };
  document: { status: number; bytes: number; title: string | null };
  resources: Array<{
    url: string;
    kind: string;
    status: number | null;
    transferredBytes: number | null;
    width: number | null;
    height: number | null;
    skipped?: string;
    finding?: string;
  }>;
  totals: {
    requestsAttempted: number;
    requestsOk: number;
    transferredBytes: number;
    imageBytes: number;
    fontBytes: number;
    cssBytes: number;
    scriptBytes: number;
  };
  findings: Array<{ id: string; severity: string; title: string; evidence: string; action: string; heuristic: boolean }>;
  pagespeed: { configured: boolean; lab: Record<string, { value: number | string | null; source: string; kind: string }> | null; field: Record<string, { value: number | string | null; source: string; kind: string }> | null; error?: string };
  jobId: string;
  persisted: boolean;
};

export function WebsiteAudit() {
  const { push } = useToast();
  const [url, setUrl] = useState("https://example.com/");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; hint?: string } | null>(null);
  const [report, setReport] = useState<AuditResponse | null>(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const data = await api.post<AuditResponse>("/api/v1/audits", { url, extraPages: 0 });
      setReport(data);
      push({
        tone: "ok",
        title: `Audited ${new URL(data.fetchedUrl).hostname}`,
        description: `${data.totals.requestsOk} resources · ${formatBytes(data.totals.transferredBytes)} transferred · ${data.durationMs} ms`,
      });
    } catch (error) {
      const message = error instanceof ApiClientError ? error.message : "The audit could not be completed.";
      setFailure({ message, hint: error instanceof ApiClientError ? error.hint : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Panel>
        <PanelHeader
          title="Public page URL"
          description="Fetches the document over HTTPS, parses the HTML, and inspects discoverable images, stylesheets, fonts and scripts. This is not a headless Chrome session."
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="URL" htmlFor="audit-url" hint="http(s) only. Private, loopback and link-local hosts are rejected.">
              <Input
                id="audit-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/"
                inputMode="url"
              />
            </Field>
          </div>
          <Button variant="primary" size="lg" onClick={run} loading={busy} leading={<Globe className="size-4" aria-hidden />}>
            {busy ? "Fetching…" : "Run audit"}
          </Button>
        </div>
        {busy ? (
          <div className="mt-4">
            <ProgressIndicator label="Resolving DNS, fetching the document, then inspecting linked assets…" />
          </div>
        ) : null}
        {failure ? (
          <div className="mt-4">
            <ErrorState title="Audit rejected" message={failure.message} hint={failure.hint} />
          </div>
        ) : null}
      </Panel>

      {report ? (
        <section className="animate-fade-up flex flex-col gap-6">
          <StatStrip
            items={[
              { label: "Transferred", value: formatBytes(report.totals.transferredBytes), hint: `${report.totals.requestsOk}/${report.totals.requestsAttempted} ok` },
              { label: "Images", value: formatBytes(report.totals.imageBytes) },
              { label: "CSS", value: formatBytes(report.totals.cssBytes) },
              { label: "Duration", value: `${report.durationMs} ms` },
            ]}
          />

          <Panel as="aside">
            <div className="flex gap-3.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-md border border-line bg-surface-sunken text-accent">
                <Info className="size-4" aria-hidden />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-ink">Coverage</h2>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">{report.coverage.note}</p>
                <p className="mt-1 font-mono text-2xs text-muted">
                  {report.document.title ?? "(no title)"} · HTTP {report.document.status} · {formatBytes(report.document.bytes)}
                </p>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Lab vs field" description="Lighthouse/CrUX numbers appear only when PAGESPEED_API_KEY is configured. They are never invented from file sizes." />
            {report.pagespeed.configured && report.pagespeed.lab ? (
              <dl className="grid gap-3 sm:grid-cols-3">
                {Object.entries(report.pagespeed.lab).map(([key, metric]) => (
                  <div key={key} className="border border-line px-3 py-2">
                    <dt className="text-2xs tracking-[0.1em] text-muted uppercase">{key} · {metric.kind}</dt>
                    <dd className="mt-1 font-mono text-sm tnum text-ink">{metric.value ?? "—"}</dd>
                    <p className="mt-1 text-2xs text-muted">{metric.source}</p>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted">{report.pagespeed.error}</p>
            )}
            {report.pagespeed.field ? (
              <p className="mt-3 text-xs text-muted">
                Field (CrUX):{" "}
                {Object.entries(report.pagespeed.field)
                  .map(([k, m]) => `${k}=${m.value ?? "unavailable"}`)
                  .join(" · ")}
              </p>
            ) : null}
          </Panel>

          <Panel>
            <PanelHeader title="Findings" />
            <ul className="flex flex-col gap-2">
              {report.findings.map((finding) => (
                <li key={finding.id} className="border border-line px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={finding.severity === "warning" ? "warn" : finding.severity === "issue" ? "danger" : "neutral"}>
                      {finding.severity}
                    </StatusBadge>
                    <p className="text-sm font-medium text-ink">{finding.title}</p>
                    {finding.heuristic ? <span className="font-mono text-2xs text-muted">heuristic</span> : null}
                  </div>
                  <p className="mt-1 text-xs text-muted">{finding.evidence}</p>
                  <p className="mt-1 text-xs text-ink-soft">{finding.action}</p>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel padded={false}>
            <div className="px-4 pt-4 sm:px-5">
              <PanelHeader title="Resource inventory" description="Sizes are the bytes we actually downloaded, not estimated." />
            </div>
            <TableShell minWidth={720}>
              <thead>
                <tr>
                  <Th>URL</Th>
                  <Th>Kind</Th>
                  <Th numeric>Status</Th>
                  <Th numeric>Bytes</Th>
                  <Th numeric>Dimensions</Th>
                </tr>
              </thead>
              <tbody>
                {report.resources.map((resource) => (
                  <tr key={resource.url}>
                    <Td mono>
                      <span className="block max-w-[22rem] truncate" title={resource.url}>
                        {resource.url}
                      </span>
                      {resource.skipped ? <span className="block text-2xs text-danger">{resource.skipped}</span> : null}
                      {resource.finding ? <span className="block text-2xs text-muted">{resource.finding}</span> : null}
                    </Td>
                    <Td mono>{resource.kind}</Td>
                    <Td numeric>{resource.status ?? "—"}</Td>
                    <Td numeric>{resource.transferredBytes != null ? formatBytes(resource.transferredBytes) : "—"}</Td>
                    <Td numeric>{resource.width && resource.height ? `${resource.width}×${resource.height}` : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </Panel>
        </section>
      ) : null}
    </div>
  );
}
