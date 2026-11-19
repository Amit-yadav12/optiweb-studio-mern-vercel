import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState, ErrorState, Notice, ProgressIndicator, StatusBadge } from "@/components/ui/Feedback";
import { DefinitionRow, Panel, PanelHeader, StatStrip, TableShell, Td, Th } from "@/components/ui/Layout";
import { ApiClientError, api, artifactUrl } from "@/lib/api-client";
import { formatBytes, formatNumber, formatRelativeTime } from "@/lib/format";
import { statusToneFor } from "@/lib/status";
import type { UsageSummary } from "@/types/domain";

/** Loads the session's usage. `refreshKey` reloads it, for example after a job has finished. */
function useUsage(refreshKey: number) {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const load = useCallback(async () => {
    try {
      setUsage(await api.get<UsageSummary>("/api/v1/usage"));
      setError(null);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : "Usage could not be loaded.", hint: err instanceof ApiClientError ? err.hint : undefined });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  return { usage, error, reload: load };
}

/** Share of the quota in use, as a labelled bar. The numbers next to it carry the same information as text. */
function QuotaBar({ usage }: { usage: UsageSummary }) {
  const percent = usage.quotaBytes > 0 ? Math.min(100, (usage.usedBytes / usage.quotaBytes) * 100) : 0;
  return (
    <div>
      <div
        className="h-2 w-full overflow-hidden border border-line bg-surface-sunken"
        role="meter"
        aria-label="Storage in use"
        aria-valuemin={0}
        aria-valuemax={usage.quotaBytes}
        aria-valuenow={usage.usedBytes}
        aria-valuetext={`${formatBytes(usage.usedBytes)} of ${formatBytes(usage.quotaBytes)} in use`}
      >
        <div className={`h-full ${usage.nearQuota ? "bg-warn" : "bg-accent"}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1.5 font-mono text-2xs text-muted">
        {formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)} in use · {formatBytes(usage.remainingBytes)} free
      </p>
    </div>
  );
}

/** Compact storage summary for the Image Optimizer page. Renders nothing while direct uploads are unavailable. */
export function StorageUsagePanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const { usage, error } = useUsage(refreshKey);
  if (error || !usage || !usage.available) return null;
  return (
    <Panel as="aside" labelledBy="storage-panel">
      <PanelHeader
        id="storage-panel"
        title="Storage for this session"
        description={`Source files are deleted ${usage.retention.sourceHours} hours after their job, converted files after ${Math.round(usage.retention.artifactHours / 24)} days.`}
        actions={<ButtonLink href="/app/usage" variant="secondary" size="sm">Details</ButtonLink>}
      />
      <QuotaBar usage={usage} />
      {usage.nearQuota ? (
        <div className="mt-3">
          <Notice tone="warn" title="Storage is almost full">
            New uploads are refused once the quota is reached. Delete jobs you no longer need in History, or wait for stored files to expire.
          </Notice>
        </div>
      ) : null}
      <dl className="mt-3">
        <DefinitionRow label="Jobs in progress" value={`${usage.activeJobs} of ${usage.maxActiveJobs}`} />
        <DefinitionRow label="Converted files kept" value={`${formatNumber(usage.files.artifacts)} · ${formatBytes(usage.artifactBytes)}`} />
        <DefinitionRow label="Source files kept" value={`${formatNumber(usage.files.sources)} · ${formatBytes(usage.sourceBytes)}`} />
      </dl>
    </Panel>
  );
}

/** The full storage page: quota, what is kept, what expires soon, recent jobs, and a way to free space. */
export function StorageUsageDetails() {
  const [tick, setTick] = useState(0);
  const { usage, error, reload } = useUsage(tick);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const clearAll = async () => {
    if (!window.confirm("Delete every job of this session, with its source and converted files? This cannot be undone.")) return;
    setClearing(true);
    setClearError(null);
    try {
      await api.del("/api/v1/history");
      setTick((value) => value + 1);
    } catch (err) {
      setClearError(err instanceof Error ? err.message : "The files could not be deleted.");
    } finally {
      setClearing(false);
    }
  };

  if (error) return <ErrorState title="Usage unavailable" message={error.message} hint={error.hint ?? "The other tools still work."} action={<Button variant="secondary" size="sm" onClick={() => void reload()}>Try again</Button>} />;
  if (!usage) return <ProgressIndicator label="Loading storage usage…" />;
  if (!usage.available) {
    return (
      <Panel>
        <EmptyState
          title="Large uploads are not set up on this deployment"
          description="Files are optimized inside the request and are not kept in object storage, so there is no storage to report. Small files can still be optimized, and their results are listed in History when the database is available."
        />
      </Panel>
    );
  }

  return (
    <>
      <Panel labelledBy="quota-panel">
        <PanelHeader id="quota-panel" title="Storage quota" description="Everything this browser session keeps on the server counts: source files, converted files, and uploads in progress." />
        <QuotaBar usage={usage} />
        {usage.nearQuota ? (
          <div className="mt-4">
            <Notice tone="warn" title="Storage is almost full">New uploads are refused once the quota is reached.</Notice>
          </div>
        ) : null}
        <div className="mt-4">
          <StatStrip
            items={[
              { label: "Converted files", value: formatBytes(usage.artifactBytes), hint: `${formatNumber(usage.files.artifacts)} file${usage.files.artifacts === 1 ? "" : "s"}` },
              { label: "Source files", value: formatBytes(usage.sourceBytes), hint: `${formatNumber(usage.files.sources)} file${usage.files.sources === 1 ? "" : "s"}` },
              { label: "Uploads in progress", value: formatBytes(usage.reservedBytes), hint: "reserved" },
              { label: "Jobs in progress", value: `${usage.activeJobs} of ${usage.maxActiveJobs}` },
            ]}
          />
        </div>
      </Panel>

      <Panel labelledBy="retention-panel">
        <PanelHeader id="retention-panel" title="How long files are kept" description="Files are deleted automatically. A job's record stays in History after its files are gone, and says so." />
        <dl>
          <DefinitionRow label="Source uploads" value={`${usage.retention.sourceHours} hours after the job finished`} mono={false} />
          <DefinitionRow label="Converted files" value={`${Math.round(usage.retention.artifactHours / 24)} days`} mono={false} />
          <DefinitionRow label="Job records in History" value={`${usage.retention.historyDays} days`} mono={false} />
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button variant="danger" onClick={clearAll} loading={clearing}>Delete all jobs and files</Button>
          <ButtonLink href="/app/history" variant="secondary">Delete single jobs in History</ButtonLink>
        </div>
        {clearError ? <p className="mt-3 text-sm text-danger" role="alert">{clearError}</p> : null}
      </Panel>

      <Panel labelledBy="expiring-panel">
        <PanelHeader id="expiring-panel" title="Expiring within three days" description="Download these converted files now if you still need them." />
        {usage.expiringSoon.length === 0 ? (
          <EmptyState title="Nothing is about to expire" description="Converted files that are close to the end of their retention period are listed here." />
        ) : (
          <TableShell minWidth={560}>
            <thead><tr><Th>File</Th><Th numeric>Size</Th><Th>Expires</Th><Th /></tr></thead>
            <tbody>
              {usage.expiringSoon.map((file) => (
                <tr key={file.artifactId}>
                  <Td mono>{file.filename}</Td>
                  <Td numeric>{formatBytes(file.bytes)}</Td>
                  <Td>{new Date(file.expiresAt).toLocaleString()}</Td>
                  <Td><a className="text-xs font-medium text-accent hover:underline" href={artifactUrl(file.artifactId)}>Download</a></Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Panel>

      <Panel labelledBy="recent-panel">
        <PanelHeader id="recent-panel" title="Recent background jobs" description="Counts since this session began are below the table." />
        {usage.recentJobs.length === 0 ? (
          <EmptyState title="No background jobs yet" description="Jobs started in the Image Optimizer appear here." action={<ButtonLink href="/app/images" variant="primary" size="sm">Optimize images</ButtonLink>} />
        ) : (
          <TableShell minWidth={560}>
            <thead><tr><Th>Started</Th><Th>Status</Th><Th numeric>Files</Th><Th numeric>Input</Th><Th numeric>Saved</Th><Th /></tr></thead>
            <tbody>
              {usage.recentJobs.map((job) => (
                <tr key={job.id}>
                  <Td>{formatRelativeTime(job.createdAt)}</Td>
                  <Td><StatusBadge tone={statusToneFor(job.state)}>{job.state}</StatusBadge></Td>
                  <Td numeric>{formatNumber(job.files)}</Td>
                  <Td numeric>{formatBytes(job.inputBytes)}</Td>
                  <Td numeric>{formatBytes(job.savedBytes)}</Td>
                  <Td><Link className="text-xs font-medium text-accent hover:underline" to={`/app/history/${job.id}`}>Open</Link></Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
        <div className="mt-4">
          <StatStrip
            items={[
              { label: "Jobs", value: formatNumber(usage.lifetime.jobs) },
              { label: "Failed jobs", value: formatNumber(usage.lifetime.failedJobs) },
              { label: "Uploaded", value: formatBytes(usage.lifetime.uploadBytes), hint: `${formatNumber(usage.lifetime.uploads)} file${usage.lifetime.uploads === 1 ? "" : "s"}` },
              { label: "Converted output", value: formatBytes(usage.lifetime.outputBytes) },
            ]}
          />
        </div>
      </Panel>
    </>
  );
}
