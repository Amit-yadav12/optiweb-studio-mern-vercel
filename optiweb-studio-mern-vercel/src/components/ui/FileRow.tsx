import { FileWarning, RotateCcw, X } from "lucide-react";
import { StatusBadge } from "@/components/ui/Feedback";
import { statusToneFor } from "@/lib/status";
import { IconButton } from "@/components/ui/Button";
import { formatBytes } from "@/lib/format";

export type FileRowStatus = "ready" | "uploading" | "processing" | "completed" | "failed";

/**
 * One queued or processed file. Status is always spelled out — the badge tone is
 * never the only signal.
 */
export function FileRow({
  name,
  status,
  detail,
  saved,
  error,
  onRemove,
  onRetry,
  thumbnail,
}: {
  name: string;
  status: FileRowStatus;
  detail: string;
  saved?: { bytes: number; percent: number } | null;
  error?: string | null;
  onRemove?: () => void;
  onRetry?: () => void;
  thumbnail?: string | null;
}) {
  return (
    <li className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
      <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded border border-line bg-surface-sunken">
        {thumbnail ? (
          <img src={thumbnail} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <span className="font-mono text-2xs text-muted">{extOf(name)}</span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm text-ink" title={name}>
            {name}
          </p>
          <StatusBadge tone={statusToneFor(status)}>{status}</StatusBadge>
        </div>
        <p className="mt-0.5 truncate font-mono text-2xs text-muted">
          {detail}
          {saved ? (
            <span className="ml-2 text-ok">
              saved {formatBytes(saved.bytes)} ({saved.percent > 0 ? "+" : ""}
              {saved.percent.toFixed(1)}%)
            </span>
          ) : null}
        </p>
        {error ? (
          <p className="mt-1 flex items-start gap-1.5 text-xs text-danger">
            <FileWarning className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onRetry ? (
          <IconButton label={`Retry ${name}`} onClick={onRetry}>
            <RotateCcw className="size-3.5" />
          </IconButton>
        ) : null}
        {onRemove ? (
          <IconButton label={`Remove ${name}`} onClick={onRemove}>
            <X className="size-3.5" />
          </IconButton>
        ) : null}
      </div>
    </li>
  );
}

function extOf(name: string): string {
  const match = /\.([a-z0-9]{2,5})$/i.exec(name);
  return (match?.[1] ?? "file").toUpperCase();
}

