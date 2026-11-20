# Unikit Studio: design tokens and contrast

Tokens live in `src/styles.css`: the light palette in `@theme`, the dark
palette under `:root[data-theme="dark"]`. The ratios below are computed with
the WCAG 2.1 relative-luminance formula from those values.
`npm run test:a11y` recomputes them on every run and fails when a text pair
falls below 4.5:1 in either theme.

```
contrast(A, B) = (L(lighter) + 0.05) / (L(darker) + 0.05)
```

## Text

| Text on background | Light | Dark |
| --- | --- | --- |
| `ink` on `canvas` | 15.33:1 | 15.74:1 |
| `ink` on `surface` | 16.29:1 | 14.61:1 |
| `ink` on `surface-sunken` | 14.79:1 | 15.34:1 |
| `ink-soft` on `canvas` | 8.55:1 | 11.42:1 |
| `ink-soft` on `surface` | 9.08:1 | 10.60:1 |
| `ink-soft` on `surface-sunken` | 8.24:1 | 11.13:1 |
| `muted` on `canvas` | 4.81:1 | 7.24:1 |
| `muted` on `surface` | 5.11:1 | 6.72:1 |
| `muted` on `surface-sunken` | 4.64:1 | 7.05:1 |
| `accent` on `canvas` | 5.16:1 | 6.06:1 |
| `accent` on `surface` | 5.48:1 | 5.62:1 |
| `accent-hover` on `accent-soft` | 6.23:1 | 6.47:1 |
| `on-accent` on `accent` (primary button) | 5.48:1 | 6.25:1 |
| `on-accent` on `accent-hover` | 7.03:1 | 7.91:1 |
| `ok` on `surface` | 7.09:1 | 8.22:1 |
| `ok` on `ok-soft` | 6.21:1 | 7.63:1 |
| `warn` on `surface` | 6.11:1 | 7.75:1 |
| `warn` on `warn-soft` | 5.56:1 | 7.29:1 |
| `danger` on `surface` | 7.04:1 | 7.07:1 |
| `danger` on `danger-soft` | 6.15:1 | 7.11:1 |

`on-accent` is the text colour on an accent-coloured surface. It is white in
the light theme and near-black in the dark theme, where the accent is a light
blue: white on it would reach about 3:1.

## Not for text

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `faint` on `surface` | 2.89:1 | 3.78:1 | Decorative icons and rules only. The accessibility test fails when an element in this colour holds words. |
| `accent` on `surface-sunken` (focus ring) | 4.98:1 | 5.90:1 | The 2 px focus outline; above 3:1 on every surface. |
| `line-strong` on `surface` | 1.41:1 | 1.64:1 | Borders of inputs and secondary buttons. |

**Known gap.** The border of an input or a secondary button is below the 3:1
that WCAG 1.4.11 asks for the boundary of a control. Controls are also marked
by their label and position, and keyboard focus draws the accent outline, but
the border itself does not meet that criterion.

## Theme

1. `localStorage["unikit:theme"]`, `"light"` or `"dark"`, when the visitor chose one.
2. Otherwise the system's `prefers-color-scheme`, followed live.
3. `light` when storage is unavailable.

`public/theme.js` writes the result to `<html data-theme="…">`. It is loaded
as a blocking script in `<head>`, so the right palette is in place before the
first paint. It is a file, not an inline script, because the
Content-Security-Policy allows no inline script. The header control cycles
system, light, dark; "system" removes the stored choice.

## Motion

Animations and transitions are reduced to nothing when the system asks for
reduced motion (`prefers-reduced-motion: reduce`), and when the visitor turns
on "Reduce motion" in Settings, which adds the class `uk-reduce-motion` to
`<html>`. `public/theme.js` applies that class before the first paint too.

## Type

Inter (variable) for text, JetBrains Mono for numbers, code and labels. Both
are served by the site itself, as Latin subsets. Two consequences:

- The mono subset has no arrow glyphs. Text set in mono uses words or `·`.
- Contextual alternates are off (`"calt" 0`), so that Inter does not turn the
  `x` in a file name such as `photo-800x600.jpg` into a multiplication sign.
