/** Formatting helpers shared by the UI. Numbers use a stable unit ladder. */

export function formatBytes(bytes: number, options?: { digits?: number }): string {
  const { digits = 1 } = options ?? {};
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs < 1) return `${sign}0 B`;
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1024 * 1024) return `${sign}${trim(abs / 1024, digits)} KB`;
  if (abs < 1024 * 1024 * 1024) return `${sign}${trim(abs / (1024 * 1024), digits)} MB`;
  return `${sign}${trim(abs / (1024 * 1024 * 1024), digits)} GB`;
}

function trim(value: number, digits: number): string {
  const rounded = value.toFixed(digits);
  return rounded.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** Signed savings percentage, e.g. "+68.4%" or "-12.1%" (output grew). */
export function formatSavingsPercent(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return "—";
  const rounded = Math.round(percent * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDimensions(width: number | null, height: number | null): string {
  if (!width || !height) return "—";
  return `${formatNumber(width)} × ${formatNumber(height)}`;
}

export function formatDateTime(input: string | Date): string {
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatRelativeTime(input: string | Date): string {
  const date = typeof input === "string" ? new Date(input) : input;
  const diffMs = Date.now() - date.getTime();
  if (Number.isNaN(date.getTime())) return "—";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return formatDateTime(date);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
