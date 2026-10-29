import { Link } from "react-router-dom";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md border font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out select-none disabled:cursor-not-allowed disabled:opacity-55 active:translate-y-[0.5px]";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border-accent bg-accent text-white hover:bg-accent-hover hover:border-accent-hover shadow-[0_1px_2px_rgba(23,33,43,0.16)]",
  secondary: "border-line-strong bg-surface text-ink hover:bg-surface-sunken hover:border-faint",
  ghost: "border-transparent bg-transparent text-ink-soft hover:bg-surface-sunken hover:text-ink",
  danger: "border-danger-border bg-danger-soft text-danger hover:brightness-95",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9.5 px-3.5 text-sm",
  lg: "h-11 px-5 text-sm",
};

type CommonButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  className?: string;
};

export function buttonClass({
  variant = "secondary",
  size = "md",
  fullWidth = false,
}: CommonButtonProps = {}): string {
  return [BASE, VARIANTS[variant], SIZES[size], fullWidth ? "w-full" : ""].filter(Boolean).join(" ");
}

export function Button({
  variant,
  size,
  fullWidth,
  loading = false,
  leading,
  trailing,
  children,
  className = "",
  disabled,
  type = "button",
  ...rest
}: CommonButtonProps & ComponentPropsWithoutRef<"button">) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      className={[buttonClass({ variant, size, fullWidth }), className].join(" ")}
    >
      {loading ? <Spinner /> : leading}
      {children}
      {trailing}
    </button>
  );
}

export function ButtonLink({
  href,
  variant,
  size,
  fullWidth,
  leading,
  trailing,
  children,
  className = "",
}: CommonButtonProps & { href: string }) {
  return (
    <Link
      to={href}
      className={[buttonClass({ variant, size, fullWidth }), className].join(" ")}
    >
      {leading}
      {children}
      {trailing}
    </Link>
  );
}

export function IconButton({
  label,
  children,
  variant = "ghost",
  className = "",
  type = "button",
  ...rest
}: { label: string; children: ReactNode; variant?: ButtonVariant } & ComponentPropsWithoutRef<"button">) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={label}
      className={`inline-grid size-9 place-items-center rounded-md border transition-colors duration-150 ${
        variant === "ghost"
          ? "border-transparent text-muted hover:bg-surface-sunken hover:text-ink"
          : "border-line-strong bg-surface text-ink-soft hover:bg-surface-sunken"
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={`size-3.5 animate-spin ${className}`} role="presentation">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M8 1.5A6.5 6.5 0 0 1 14.5 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
