/**
 * Product mark: three bars compressed into the same column — the optimisation
 * idea in one glyph. Used in the sidebar, the landing hero and the footer.
 *
 * The bars use `currentColor` and the accent token, so the mark adapts to the
 * active theme instead of carrying a fixed palette.
 */
export function ProductMark({
  size = 28,
  tone = "ink",
}: {
  size?: number;
  tone?: "ink" | "inverse" | "accent";
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      role="img"
      aria-label="OptiWeb Studio"
      className={tone === "inverse" ? "text-white" : tone === "accent" ? "text-accent" : "text-ink"}
    >
      <rect
        x="0.75"
        y="0.75"
        width="26.5"
        height="26.5"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.22"
        strokeWidth="1.5"
      />
      <rect x="7" y="6.5" width="14" height="3" fill="currentColor" />
      <rect x="7" y="12.5" width="9.5" height="3" fill="currentColor" />
      <rect x="7" y="18.5" width="5" height="3" fill="var(--color-accent)" />
    </svg>
  );
}

export function Wordmark({ tone = "ink", compact = false }: { tone?: "ink" | "inverse"; compact?: boolean }) {
  return (
    <span className={`flex items-center gap-2.5 ${compact ? "" : ""}`}>
      <ProductMark size={26} tone={tone === "inverse" ? "inverse" : "ink"} />
      <span className="flex flex-col leading-none">
        <span className={`text-sm font-semibold tracking-[-0.01em] ${tone === "inverse" ? "text-white" : "text-ink"}`}>
          OptiWeb Studio
        </span>
        <span
          className={`mt-1 font-mono text-2xs tracking-[0.1em] uppercase ${tone === "inverse" ? "text-white/60" : "text-muted"}`}
        >
          Make every byte count
        </span>
      </span>
    </span>
  );
}
