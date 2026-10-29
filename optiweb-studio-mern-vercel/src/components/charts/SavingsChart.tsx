import { formatBytes } from "@/lib/format";

export type ChartRow = { label: string; input: number; output: number };

/**
 * Original-vs-optimized weight chart. Bars are proportional to real byte counts;
 * when the optimized file is larger, the second bar is drawn in the danger tone
 * so a regression is visible instead of hidden.
 */
export function SavingsChart({ rows, max }: { rows: ChartRow[]; max?: number }) {
  const peak = max ?? Math.max(...rows.map((row) => Math.max(row.input, row.output)), 1);
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="flex flex-col gap-3">
      <div className="relative pl-20">
        <div className="absolute inset-y-0 left-20 right-0 flex justify-between" aria-hidden>
          {ticks.map((tick) => (
            <span key={tick} className="w-px bg-line" style={{ height: "100%" }} />
          ))}
        </div>
        <div className="flex justify-between pr-0.5 pb-1.5 font-mono text-2xs text-faint tnum" aria-hidden>
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <span key={tick}>{formatBytes(peak * tick)}</span>
          ))}
        </div>
        <ul className="flex flex-col gap-3">
          {rows.map((row) => {
            const grew = row.output > row.input;
            const inputWidth = `${Math.max(1, (row.input / peak) * 100)}%`;
            const outputWidth = `${Math.max(1, (row.output / peak) * 100)}%`;
            return (
              <li key={row.label} className="relative">
                <span className="absolute top-0 -left-20 max-w-[4.6rem] truncate pr-2 font-mono text-2xs text-muted">
                  {row.label}
                </span>
                <div className="flex flex-col gap-1">
                  <div className="h-3 rounded-r-sm bg-line-strong/70" style={{ width: inputWidth }} />
                  <div
                    className={`h-3 rounded-r-sm ${grew ? "bg-danger/70" : "bg-accent"}`}
                    style={{ width: outputWidth }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="flex items-center gap-4 pt-1 text-2xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-line-strong" aria-hidden /> original
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-accent" aria-hidden /> optimized
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-danger/70" aria-hidden /> larger than source
        </span>
      </div>
    </div>
  );
}
