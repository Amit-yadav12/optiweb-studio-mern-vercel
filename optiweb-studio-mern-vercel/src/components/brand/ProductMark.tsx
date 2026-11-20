/**
 * The Unikit Studio mark: a "U" whose right stem ends in a separate block.
 * The block is one piece of the kit; the stem it sits on is the rest.
 *
 * The same drawing is used for the favicon and the app icons in `public/`.
 */
export const BRAND_NAME = "Unikit Studio";
export const BRAND_TAGLINE = "Runs in your browser";

export function ProductMark({ size = 28, tone = "accent" }: { size?: number; tone?: "accent" | "inverse" }) {
  // "accent": the brand colour with a white glyph. "inverse": a white tile with the glyph in the brand colour, for dark surfaces.
  const tile = tone === "inverse" ? "#ffffff" : "var(--color-accent)";
  const glyph = tone === "inverse" ? "var(--color-accent)" : "#ffffff";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={BRAND_NAME} className="shrink-0">
      <rect width="32" height="32" rx="7" fill={tile} />
      <path d="M9.5 8.2v8.3a6.5 6.5 0 0 0 13 0v-2.2" fill="none" stroke={glyph} strokeWidth="3.4" strokeLinecap="round" />
      <rect x="20.2" y="6.5" width="4.6" height="4.6" rx="1.1" fill={glyph} />
    </svg>
  );
}

/** The mark with the name set next to it. The name is real text, so it is read by screen readers and can be selected. */
export function Wordmark({ tone = "ink", tagline = true }: { tone?: "ink" | "inverse"; tagline?: boolean }) {
  const inverse = tone === "inverse";
  return (
    <span className="flex items-center gap-2.5">
      <ProductMark size={26} tone={inverse ? "inverse" : "accent"} />
      <span className="flex flex-col leading-none">
        <span className={`text-sm tracking-[0.06em] whitespace-nowrap uppercase ${inverse ? "text-white" : "text-ink"}`}>
          <span className="font-semibold">Unikit</span> <span className={`font-normal ${inverse ? "text-white/70" : "text-ink-soft"}`}>Studio</span>
        </span>
        {tagline ? <span className={`mt-1 font-mono text-2xs tracking-[0.1em] uppercase ${inverse ? "text-white/60" : "text-muted"}`}>{BRAND_TAGLINE}</span> : null}
      </span>
    </span>
  );
}
