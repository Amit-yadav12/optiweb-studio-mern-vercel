import type { ReactNode } from "react";

/** Page title block with the measurement-rule motif underneath. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 pb-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-2xs font-medium tracking-[0.14em] text-muted uppercase">{eyebrow}</p>
          ) : null}
          <h1 className="mt-1.5 text-2xl font-semibold tracking-[-0.015em] text-ink">{title}</h1>
          {description ? (
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className="rule-ticks h-[5px] w-full" aria-hidden />
    </header>
  );
}

/** Card-like container. Uses surface + hairline border, never a heavy shadow. */
export function Panel({
  children,
  className = "",
  as: Tag = "section",
  labelledBy,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article" | "aside";
  labelledBy?: string;
  padded?: boolean;
}) {
  return (
    <Tag
      aria-labelledby={labelledBy}
      className={`border border-line bg-surface ${padded ? "p-4 sm:p-5" : ""} ${className}`}
    >
      {children}
    </Tag>
  );
}

export function PanelHeader({
  title,
  description,
  actions,
  id,
  meta,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  id?: string;
  meta?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 id={id} className="text-sm font-semibold tracking-[-0.01em] text-ink">
            {title}
          </h2>
          {meta}
        </div>
        {description ? <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function DefinitionRow({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-b-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`text-xs text-ink ${mono ? "font-mono tnum" : ""}`}>{value}</dd>
    </div>
  );
}

/** A measured value with an aligned numeric figure and a caption. */
export function Metric({
  label,
  value,
  unit,
  caption,
  tone = "neutral",
}: {
  label: string;
  value: string;
  unit?: string;
  caption?: string;
  tone?: "neutral" | "ok" | "accent" | "danger";
}) {
  const toneClass =
    tone === "ok" ? "text-ok" : tone === "accent" ? "text-accent" : tone === "danger" ? "text-danger" : "text-ink";
  return (
    <div className="min-w-0">
      <p className="text-2xs font-medium tracking-[0.1em] text-muted uppercase">{label}</p>
      <p className={`mt-1.5 font-mono text-lg leading-none font-medium tnum ${toneClass}`}>
        {value}
        {unit ? <span className="ml-1 text-xs font-normal text-muted">{unit}</span> : null}
      </p>
      {caption ? <p className="mt-1.5 text-xs leading-snug text-muted">{caption}</p> : null}
    </div>
  );
}

/** Aligned stat strip used above tables. */
export function StatStrip({ items }: { items: Array<{ label: string; value: string; hint?: string }> }) {
  return (
    <dl className="grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="bg-surface px-4 py-3">
          <dt className="text-2xs font-medium tracking-[0.1em] text-muted uppercase">{item.label}</dt>
          <dd className="mt-1 font-mono text-base font-medium tnum text-ink">{item.value}</dd>
          {item.hint ? <p className="mt-0.5 text-2xs text-ink-soft">{item.hint}</p> : null}
        </div>
      ))}
    </dl>
  );
}

/** Simple, accessible data table shell: sticky header, aligned numeric columns. */
export function TableShell({ children, minWidth = 720 }: { children: ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  align = "left",
  numeric,
  width,
}: {
  children?: ReactNode;
  align?: "left" | "right";
  numeric?: boolean;
  width?: number | string;
}) {
  return (
    <th
      scope="col"
      style={width ? { width } : undefined}
      className={`border-b border-line bg-surface-sunken/60 px-3 py-2.5 text-2xs font-medium tracking-[0.08em] text-muted uppercase ${
        numeric ? "text-right" : align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  numeric,
  className = "",
  mono,
}: {
  children?: ReactNode;
  numeric?: boolean;
  mono?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`border-b border-line px-3 py-2.5 align-middle text-sm text-ink-soft ${
        numeric ? "text-right font-mono tnum text-ink" : mono ? "font-mono text-xs" : ""
      } ${className}`}
    >
      {children}
    </td>
  );
}


export function FormatTag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-line bg-surface-sunken px-1.5 py-0.5 font-mono text-2xs tracking-wide text-ink-soft uppercase">
      {children}
    </span>
  );
}

export function InlineNote({ children }: { children: ReactNode }) {
  return (
    <p className="border-l-2 border-line-strong pl-3 text-xs leading-relaxed text-muted">{children}</p>
  );
}

