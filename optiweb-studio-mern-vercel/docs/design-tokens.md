# OptiWeb Studio — design tokens & contrast evidence

Tokens live in `src/app/globals.css`. Both palettes were checked with the WCAG 2.1 relative
luminance formula; the numbers below are computed, not estimated.

```
contrast(A, B) = (L(lighter) + 0.05) / (L(darker) + 0.05)
```

## Light theme

| Pair | Ratio | AA (4.5:1) |
| --- | --- | --- |
| `ink` on `surface` | 16.29:1 | pass |
| `ink-soft` on `canvas` | 8.55:1 | pass |
| `muted` on `canvas` | 4.81:1 | pass |
| `muted` on `surface-sunken` | 4.64:1 | pass |
| `accent` on `surface` | 5.48:1 | pass |
| `accent-hover` on `accent-soft` | 6.23:1 | pass |
| `ok` on `ok-soft` | 6.21:1 | pass |
| `warn` on `warn-soft` | 5.56:1 | pass |
| `danger` on `danger-soft` | 6.15:1 | pass |
| white on `navy` | 17.12:1 | pass |

`faint` measures 2.89:1 on white and is therefore **reserved for decoration only** (code line
numbers, chart tick labels marked `aria-hidden`, footer credits). Every label that carries
meaning uses `muted` or darker.

## Dark theme (`data-theme="dark"`)

| Pair | Ratio | AA (4.5:1) |
| --- | --- | --- |
| `ink` on `surface` | 14.61:1 | pass |
| `ink` on `canvas` | 15.74:1 | pass |
| `ink-soft` on `canvas` | 11.42:1 | pass |
| `ink-soft` on `surface` | 10.60:1 | pass |
| `muted` on `surface` | 6.72:1 | pass |
| `muted` on `canvas` | 7.24:1 | pass |
| `muted` on `surface-sunken` | 7.05:1 | pass |
| `accent` on `surface` | 5.62:1 | pass |
| `accent` on `canvas` | 6.06:1 | pass |
| `accent-hover` on `accent-soft` | 6.47:1 | pass |
| white on `navy` | 19.10:1 | pass |
| `ok` on `ok-soft` | 7.63:1 | pass |
| `warn` on `warn-soft` | 7.29:1 | pass |
| `danger` on `danger-soft` | 7.11:1 | pass |
| `faint` on `surface` (decorative) | 3.78:1 | pass (≥3:1 UI) |

## Theme resolution

1. `localStorage["ow-theme"]` — `"light"` or `"dark"` — if the user pinned a choice.
2. Otherwise the OS `prefers-color-scheme`, re-evaluated live while un-pinned.
3. Fallback `light` if `localStorage` is unavailable (private mode, blocked cookies).

The resolved value is written to `<html data-theme="…">` by a blocking inline script in `<head>`
(`src/lib/theme-bootstrap.ts`), so the correct palette is applied before the first frame — no
flash of the wrong theme. `color-scheme: light` / `dark` is set alongside it so native controls,
scrollbars and `<input type="range">` follow.

The header control cycles **system → light → dark**. "system" removes the stored override, which
is what lets the OS preference take over again. It reads state through `useSyncExternalStore`
backed by a `MutationObserver` on the `data-theme` attribute plus a `matchMedia` listener, so the
icon stays truthful even if the theme is changed from another tab.

## Motion

- OS level: `@media (prefers-reduced-motion: reduce)` collapses all animation/transition
  durations.
- Session level: the "Minimise interface motion" preference in Settings adds `.ow-reduce-motion`
  to `<html>`, which applies the same collapse independently of the OS setting.
