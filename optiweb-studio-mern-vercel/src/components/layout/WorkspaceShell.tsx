import { Link, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { Gauge, Globe, ImageDown, Menu, ScanSearch, Settings2, Type, X } from "lucide-react";
import { Wordmark } from "@/components/brand/ProductMark";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { usePreferences } from "@/lib/preferences";
import { REDUCE_MOTION_CLASS } from "@/lib/storage-keys";

const NAV_GROUPS: Array<{
  label: string;
  items: Array<{ href: string; label: string; icon: typeof Gauge; hint: string }>;
}> = [
  {
    label: "Workspace",
    items: [
      { href: "/app", label: "Overview", icon: Gauge, hint: "The tools, and how your files are handled" },
      { href: "/app/images", label: "Image Optimizer", icon: ImageDown, hint: "Convert and compress images" },
      { href: "/app/fonts", label: "Font Optimizer", icon: Type, hint: "Audit and patch font-display" },
      { href: "/app/assets", label: "Asset Analyzer", icon: ScanSearch, hint: "Inspect files on this device" },
      { href: "/app/audit", label: "Website Audit", icon: Globe, hint: "Inspect a public page and its assets" },
    ],
  },
  {
    label: "Preferences",
    items: [{ href: "/app/settings", label: "Settings", icon: Settings2, hint: "Defaults, kept in this browser" }],
  },
];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useLocation().pathname;
  return (
    <nav aria-label="Workspace" className="flex flex-col gap-6">
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="px-3 pb-2 text-2xs font-medium tracking-[0.14em] text-muted uppercase">{group.label}</p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href || (item.href !== "/app" && pathname.startsWith(`${item.href}/`));
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    to={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    title={item.hint}
                    className={`group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors duration-150 ${
                      active
                        ? "bg-accent-soft font-medium text-accent-hover"
                        : "text-ink-soft hover:bg-surface-sunken hover:text-ink"
                    }`}
                  >
                    {active ? (
                      <span className="absolute top-1/2 left-0 h-4 w-[2px] -translate-y-1/2 rounded-r bg-accent" aria-hidden />
                    ) : null}
                    <Icon className={`size-4 shrink-0 ${active ? "text-accent" : "text-faint group-hover:text-ink-soft"}`} aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <Link to="/" className="flex items-center rounded-md px-1 py-1" aria-label="Unikit Studio home">
      <Wordmark />
    </Link>
  );
}

export function WorkspaceShell({
  children,
  title,
  context,
  actions,
}: {
  children: React.ReactNode;
  title: string;
  context?: string;
  actions?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    document.title = `${title} · Unikit Studio`;
  }, [title]);

  // "Reduce motion" from Settings turns animations off beyond the system-wide setting.
  const { reduceMotion } = usePreferences();
  useEffect(() => {
    document.documentElement.classList.toggle(REDUCE_MOTION_CLASS, reduceMotion);
  }, [reduceMotion]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen flex-col justify-between border-r border-line bg-surface px-4 py-5 lg:flex">
        <div className="flex flex-col gap-7">
          <Brand />
          <NavList />
        </div>
        <div className="border-t border-line pt-4">
          <p className="font-mono text-2xs leading-relaxed text-muted">
            v2.0 · runs in your browser
            <br />
            no uploads · no cookies
          </p>
        </div>
      </aside>

      {/* Mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-80 lg:hidden">
          <div className="absolute inset-0 bg-navy/45" onClick={() => setOpen(false)} aria-hidden />
          <div className="animate-fade-up relative flex h-full w-[86%] max-w-xs flex-col gap-7 border-r border-line bg-surface px-4 py-5 shadow-overlay">
            <div className="flex items-center justify-between">
              <Brand />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="grid size-9 place-items-center rounded-md text-muted hover:bg-surface-sunken hover:text-ink"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <NavList onNavigate={() => setOpen(false)} />
            <div className="mt-auto flex items-center justify-between border-t border-line pt-4">
              <span className="font-mono text-2xs tracking-[0.1em] text-muted uppercase">Appearance</span>
              <ThemeToggle />
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-40 border-b border-line bg-canvas/92 backdrop-blur-sm">
          <div className="flex items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="Open navigation"
              aria-expanded={open}
              className="grid size-9 shrink-0 place-items-center rounded-md border border-line-strong bg-surface text-ink-soft lg:hidden"
            >
              <Menu className="size-4" aria-hidden />
            </button>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold tracking-[-0.01em] text-ink">{title}</span>
              {context ? <p className="truncate text-xs text-muted">{context}</p> : null}
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
            <ThemeToggle className="shrink-0" />
          </div>
        </header>
        <main id="main" className="min-w-0 flex-1 px-4 pt-5 pb-14 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
