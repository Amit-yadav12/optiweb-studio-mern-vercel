import { useCallback, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { THEME_STORAGE_KEY } from "@/lib/theme-bootstrap";

export type ThemeChoice = "system" | "light" | "dark";

const ORDER: ThemeChoice[] = ["system", "light", "dark"];

const LABEL: Record<ThemeChoice, string> = {
  system: "Theme: follow system",
  light: "Theme: light",
  dark: "Theme: dark",
};

/**
 * External store for the theme.
 *
 * The source of truth lives outside React: `data-theme` on <html> (set by the
 * bootstrap script before paint) and the localStorage override. Reading them
 * through `useSyncExternalStore` keeps the button truthful without setState-in-
 * effect, and a MutationObserver means any change (including from another tab)
 * re-renders the control.
 */
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onMediaChange = () => {
    // Only relevant while the user has not pinned an explicit theme.
    if (!window.localStorage.getItem(THEME_STORAGE_KEY)) emit();
  };
  const observer = new MutationObserver(emit);
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) emit();
  };

  media.addEventListener("change", onMediaChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(onChange);
    media.removeEventListener("change", onMediaChange);
    observer.disconnect();
    window.removeEventListener("storage", onStorage);
  };
}

/** The user's explicit choice, or "system" when nothing is pinned. */
function readChoice(): ThemeChoice {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** The palette actually applied to the document. */
function readResolved(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

const serverChoice: ThemeChoice = "system";
const serverResolved = "light" as const;

/**
 * Three-state theme control: system → light → dark.
 *
 * "system" clears the stored override so the OS preference (and live changes to
 * it) drives the palette.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const choice = useSyncExternalStore(subscribe, readChoice, () => serverChoice);
  const resolved = useSyncExternalStore(subscribe, readResolved, () => serverResolved);

  const apply = useCallback((next: ThemeChoice) => {
    if (next === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
      return;
    }
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    document.documentElement.setAttribute("data-theme", next);
  }, []);

  const Icon = choice === "system" ? Monitor : resolved === "dark" ? Moon : Sun;

  return (
    <button
      type="button"
      onClick={() => apply(ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length])}
      aria-label={LABEL[choice]}
      title={LABEL[choice]}
      className={`inline-grid size-9 place-items-center rounded-md border border-line-strong bg-surface text-ink-soft transition-colors duration-150 hover:bg-surface-sunken hover:text-ink ${className}`}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
