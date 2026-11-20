import { FileWarning, X } from "lucide-react";
import { StatusBadge, type Tone } from "@/components/ui/Feedback";
import { IconButton } from "@/components/ui/Button";

/**
 * One file in a queue. The status is always spelled out in words: the badge
 * colour is never the only signal.
 */
export function FileRow({
  name,
  status,
  tone,
  detail,
  note,
  error,
  hint,
  onRemove,
}: {
  name: string;
  /** Status in words, shown in the badge. */
  status: string;
  tone: Tone;
  /** Facts about the file: format, size, dimensions. */
  detail: string;
  /** What is happening to the file right now, or its result. */
  note?: string | null;
  error?: string | null;
  hint?: string | null;
  onRemove?: () => void;
}) {
  return (
    <li className="flex items-start gap-3 border-b border-line px-3 py-2.5 last:border-b-0" data-status={status}>
      <span className="mt-0.5 grid size-9 shrink-0 place-items-center overflow-hidden rounded border border-line bg-surface-sunken">
        <span className="font-mono text-2xs text-muted">{extOf(name)}</span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm text-ink" title={name}>
            {name}
          </p>
          <StatusBadge tone={tone}>{status}</StatusBadge>
        </div>
        <p className="mt-0.5 truncate font-mono text-2xs text-muted">
          {detail}
          {note ? <span className="ml-2 text-ink-soft">{note}</span> : null}
        </p>
        {error ? (
          <p className="mt-1 flex items-start gap-1.5 text-xs text-danger">
            <FileWarning className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>{error}</span>
          </p>
        ) : null}
        {error && hint ? <p className="mt-0.5 pl-[1.125rem] text-xs leading-relaxed text-muted">{hint}</p> : null}
      </div>
      {onRemove ? (
        <div className="flex shrink-0 items-center gap-1">
          <IconButton label={`Remove ${name}`} onClick={onRemove}>
            <X className="size-3.5" aria-hidden />
          </IconButton>
        </div>
      ) : null}
    </li>
  );
}

function extOf(name: string): string {
  const match = /\.([a-z0-9]{2,5})$/i.exec(name);
  return (match?.[1] ?? "file").toUpperCase();
}
