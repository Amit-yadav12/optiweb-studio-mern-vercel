import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Labelled form control wrapper: label, control, hint, and error wiring. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  trailing,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-xs font-medium text-ink">
          {label}
        </label>
        {trailing}
      </div>
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs leading-relaxed text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

const CONTROL =
  "w-full rounded-md border bg-surface text-ink placeholder:text-muted transition-colors duration-150 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:bg-surface-sunken";

export function Input({ className = "", invalid, ...rest }: ComponentPropsWithoutRef<"input"> & { invalid?: boolean }) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className={`h-9.5 px-2.5 text-sm ${CONTROL} ${invalid ? "border-danger" : "border-line-strong"} ${className}`}
    />
  );
}

export function Select({
  className = "",
  invalid,
  children,
  ...rest
}: ComponentPropsWithoutRef<"select"> & { invalid?: boolean }) {
  return (
    <div className="relative">
      <select
        {...rest}
        aria-invalid={invalid || undefined}
        className={`h-9.5 appearance-none pr-8 pl-2.5 text-sm ${CONTROL} ${
          invalid ? "border-danger" : "border-line-strong"
        } ${className}`}
      >
        {children}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 12 12"
        className="pointer-events-none absolute top-1/2 right-2.5 size-3 -translate-y-1/2 text-faint"
      >
        <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function Textarea({
  className = "",
  invalid,
  ...rest
}: ComponentPropsWithoutRef<"textarea"> & { invalid?: boolean }) {
  return (
    <textarea
      {...rest}
      aria-invalid={invalid || undefined}
      spellCheck={false}
      className={`code-pane resize-y px-3 py-2.5 ${CONTROL} ${invalid ? "border-danger" : "border-line-strong"} ${className}`}
    />
  );
}

/** Segmented control used for mutually exclusive, low-cardinality options. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  name,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string; hint?: string }>;
  label: string;
  name: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line-strong bg-surface-sunken p-0.5">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            name={name}
            title={option.hint}
            onClick={() => onChange(option.value)}
            className={`rounded-[5px] px-2.5 py-1.5 text-xs font-medium transition-colors duration-150 ${
              selected ? "bg-surface text-ink shadow-[0_1px_2px_rgba(23,33,43,0.12)]" : "text-muted hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
