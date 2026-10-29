import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, Check, Info, X } from "lucide-react";
import type { Tone } from "@/lib/status";

export type { Tone };

/* ---------------------------------- status --------------------------------- */

const TONE_STYLES: Record<Tone, string> = {
  neutral: "border-line bg-surface-sunken text-ink-soft",
  accent: "border-accent-border bg-accent-soft text-accent-hover",
  ok: "border-ok-border bg-ok-soft text-ok",
  warn: "border-warn-border bg-warn-soft text-warn",
  danger: "border-danger-border bg-danger-soft text-danger",
};

const TONE_ICONS: Record<Tone, ReactNode> = {
  neutral: <span className="size-1.5 rounded-full bg-faint" />,
  accent: <span className="size-1.5 rounded-full bg-accent" />,
  ok: <span className="size-1.5 rounded-full bg-ok" />,
  warn: <span className="size-1.5 rounded-full bg-warn" />,
  danger: <span className="size-1.5 rounded-full bg-danger" />,
};

/**
 * Status chip. Colour is always paired with a dot + text so status never relies
 * on colour alone.
 */
export function StatusBadge({
  tone = "neutral",
  children,
  icon,
}: {
  tone?: Tone;
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium whitespace-nowrap ${TONE_STYLES[tone]}`}
    >
      {icon ?? TONE_ICONS[tone]}
      {children}
    </span>
  );
}

/* ------------------------------ progress / load ---------------------------- */

/**
 * Indeterminate bar. The pipeline reports no partial progress, so we never fake
 * a percentage — the label carries the real state instead.
 */
export function ProgressIndicator({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-live="polite">
      <div className="h-1 overflow-hidden rounded-full bg-surface-sunken">
        <div className="animate-indeterminate h-full w-1/3 rounded-full bg-accent" />
      </div>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

export function SkeletonRows({ rows = 4, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="flex flex-col gap-2 p-4" aria-hidden>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-3">
          {Array.from({ length: columns }).map((_, colIndex) => (
            <div
              key={colIndex}
              className="animate-pulse-soft h-4 rounded bg-surface-sunken"
              style={{ width: colIndex === 0 ? "28%" : "14%" }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ empty / error ------------------------------ */

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="grid size-10 place-items-center rounded-md border border-line bg-surface-sunken text-faint">
        {icon ?? <Info className="size-4.5" />}
      </div>
      <div className="max-w-md">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title,
  message,
  hint,
  action,
}: {
  title: string;
  message: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex gap-3 border border-danger-border bg-danger-soft px-4 py-3.5">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium text-danger">{title}</p>
        <p className="mt-0.5 text-sm break-words text-danger/85">{message}</p>
        {hint ? <p className="mt-1.5 text-xs leading-relaxed text-danger/75">{hint}</p> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}

/* ---------------------------------- toasts --------------------------------- */

type Toast = { id: string; tone: Tone; title: string; description?: string };
type ToastContextValue = { push: (toast: Omit<Toast, "id">) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_ICON: Record<Tone, ReactNode> = {
  neutral: <Info className="size-3.5" />,
  accent: <Info className="size-3.5" />,
  ok: <Check className="size-3.5" />,
  warn: <AlertTriangle className="size-3.5" />,
  danger: <AlertTriangle className="size-3.5" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = crypto.randomUUID();
      setToasts((current) => [...current.slice(-2), { ...toast, id }]);
      timers.current.set(id, setTimeout(() => dismiss(id), 5200));
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-3 bottom-3 z-100 flex flex-col items-center gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:items-end"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="animate-fade-up pointer-events-auto flex w-full max-w-sm items-start gap-2.5 border border-line bg-surface px-3.5 py-3 shadow-raise"
          >
            <span className={`mt-0.5 ${toast.tone === "ok" ? "text-ok" : toast.tone === "danger" ? "text-danger" : "text-accent"}`}>
              {TOAST_ICON[toast.tone]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{toast.title}</p>
              {toast.description ? <p className="mt-0.5 text-xs leading-relaxed text-muted">{toast.description}</p> : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
              className="-mt-0.5 -mr-1 grid size-7 place-items-center rounded text-muted hover:bg-surface-sunken hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside <ToastProvider>");
  return context;
}
