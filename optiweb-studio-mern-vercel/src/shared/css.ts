/**
 * CSS font-display analysis and patching, built on PostCSS.
 *
 * It runs wherever it is imported: in the browser for the Font Optimizer and
 * the Asset Analyzer (the stylesheet never leaves the tab), and on the server
 * for stylesheets the website audit fetched from a public page.
 *
 * Safety rules:
 * - The stylesheet is parsed, not split with regular expressions, so malformed
 *   input is reported with a line number instead of producing a broken file.
 * - `font-display` is only inserted into an `@font-face` rule that parses
 *   cleanly and declares a `src`.
 * - Everything else is left byte for byte as it was.
 */
import postcss, { type AtRule, type Root } from "postcss";

export const FONT_DISPLAY_VALUES = ["auto", "block", "swap", "fallback", "optional"] as const;
export type FontDisplayPolicy = (typeof FONT_DISPLAY_VALUES)[number];

export function isFontDisplayPolicy(value: unknown): value is FontDisplayPolicy {
  return typeof value === "string" && (FONT_DISPLAY_VALUES as readonly string[]).includes(value);
}

/** Largest stylesheet that is parsed. Parsing blocks the page while it runs, and this is far above any real stylesheet. */
export const MAX_CSS_CHARS = 4_000_000;

export type PolicyNote = { label: string; behaviour: string; tradeOff: string };

export const POLICY_NOTES: Record<FontDisplayPolicy, PolicyNote> = {
  auto: {
    label: "auto",
    behaviour: "The browser uses its default font-display behaviour.",
    tradeOff: "Usually behaves like `block`: hidden text while the font loads.",
  },
  block: {
    label: "block",
    behaviour: "Text is invisible for up to ~3s while the font loads.",
    tradeOff: "Prevents the fallback flash, but risks invisible content on slow networks.",
  },
  swap: {
    label: "swap",
    behaviour: "Fallback text renders immediately and swaps when the font arrives.",
    tradeOff: "No invisible text, but a visible re-layout (layout shift) is possible.",
  },
  fallback: {
    label: "fallback",
    behaviour: "Very short block period (~100ms), then a short swap window.",
    tradeOff: "Balanced default for body text on most content sites.",
  },
  optional: {
    label: "optional",
    behaviour: "Short block period; the browser may use the fallback for the whole visit.",
    tradeOff: "Most stable layout, but the webfont may never render on slow connections.",
  },
};

export type CssFindingSeverity = "info" | "warning" | "issue";

export type CssFinding = {
  id: string;
  severity: CssFindingSeverity;
  code: "css-parse-error" | "no-font-face" | "font-face-no-src" | "font-display-present" | "font-display-missing";
  title: string;
  detail: string;
  line?: number;
  selector?: string;
};

export type CssAnalysis = {
  fontFaceCount: number;
  withFontDisplay: number;
  missingFontDisplay: number;
  malformed: number;
  findings: CssFinding[];
  parseErrors: Array<{ line: number; reason: string }>;
  policy: FontDisplayPolicy;
};

export type CssPatch = {
  /** The patched stylesheet. Identical to the input when nothing was changed. */
  output: string;
  inputBytes: number;
  outputBytes: number;
  /** Line numbers, in the output, of the lines that are new. */
  changedLines: number[];
  rulesPatched: Array<{ family: string | null; line: number; value: FontDisplayPolicy }>;
  analysis: CssAnalysis;
};

/** Why a stylesheet was not analysed at all. */
export class CssInputError extends Error {
  constructor(
    readonly code: "empty" | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "CssInputError";
  }
}

/** Length of a string in bytes when stored as UTF-8. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

type FontFaceRule = { node: AtRule; family: string | null; line: number; hasDisplay: boolean; hasSrc: boolean; value: string | null };

function collectFontFaceRules(root: Root): FontFaceRule[] {
  const rules: FontFaceRule[] = [];
  root.walkAtRules(/^font-face$/i, (node) => {
    let family: string | null = null;
    let hasSrc = false;
    let hasDisplay = false;
    let value: string | null = null;
    for (const decl of node.nodes ?? []) {
      if (decl.type !== "decl") continue;
      const prop = decl.prop.toLowerCase();
      if (prop === "font-family") family = decl.value.replace(/^["']|["']$/g, "").trim();
      if (prop === "src") hasSrc = true;
      if (prop === "font-display") {
        hasDisplay = true;
        value = decl.value.trim();
      }
    }
    rules.push({ node, family, line: node.source?.start?.line ?? 0, hasDisplay, hasSrc, value });
  });
  return rules;
}

type Parsed = CssAnalysis & { rules: FontFaceRule[]; root: Root | null };

function parseAndAnalyze(css: string, policy: FontDisplayPolicy): Parsed {
  if (!css.trim()) throw new CssInputError("empty", "No CSS supplied.");
  if (css.length > MAX_CSS_CHARS) {
    throw new CssInputError("too_large", `The stylesheet is larger than ${(MAX_CSS_CHARS / 1_000_000).toFixed(0)} million characters.`);
  }

  let root: Root;
  try {
    root = postcss.parse(css, { from: undefined });
  } catch (error) {
    const syntax = error as { reason?: string; line?: number; message?: string };
    const reason = (syntax.reason ?? syntax.message ?? "Unknown parse error").slice(0, 200);
    const line = typeof syntax.line === "number" && syntax.line > 0 ? syntax.line : 1;
    return {
      fontFaceCount: 0,
      withFontDisplay: 0,
      missingFontDisplay: 0,
      malformed: 0,
      findings: [
        {
          id: "parse-error",
          severity: "issue",
          code: "css-parse-error",
          title: "The stylesheet could not be parsed",
          detail: `Line ${line}: ${reason}. Nothing was changed. Fix the syntax error and analyse again.`,
          line,
        },
      ],
      parseErrors: [{ line, reason }],
      policy,
      rules: [],
      root: null,
    };
  }

  const rules = collectFontFaceRules(root);
  const findings: CssFinding[] = [];
  let malformed = 0;

  if (rules.length === 0) {
    findings.push({
      id: "no-font-face",
      severity: "info",
      code: "no-font-face",
      title: "No @font-face rules found",
      detail:
        "This stylesheet does not declare any webfonts. If fonts arrive from a third-party host (Google Fonts, Adobe Fonts), their CSS has to be analysed separately.",
    });
  }

  rules.forEach((rule, index) => {
    const label = rule.family ? `@font-face for “${rule.family}”` : "@font-face rule";
    if (!rule.hasSrc) {
      malformed += 1;
      findings.push({
        id: `no-src-${index}`,
        severity: "issue",
        code: "font-face-no-src",
        title: `${label} has no src descriptor`,
        detail: "Without `src` the browser cannot load the font. A rule that cannot be validated is not patched.",
        line: rule.line,
      });
      return;
    }
    if (rule.hasDisplay) {
      findings.push({
        id: `has-display-${index}`,
        severity: "info",
        code: "font-display-present",
        title: `${label} already declares font-display: ${rule.value}`,
        detail:
          rule.value?.toLowerCase() === policy
            ? `This already matches the selected ${policy} policy.`
            : "It is left as it is. The patch only adds font-display where it is missing; it does not rewrite a value someone chose.",
        line: rule.line,
        selector: label,
      });
    } else {
      findings.push({
        id: `missing-display-${index}`,
        severity: "warning",
        code: "font-display-missing",
        title: `${label} is missing font-display`,
        detail: `The browser falls back to its default behaviour, which blocks text rendering while the font downloads. Adding \`font-display: ${policy}\` makes the fallback visible immediately.`,
        line: rule.line,
        selector: label,
      });
    }
  });

  return {
    fontFaceCount: rules.length,
    withFontDisplay: rules.filter((rule) => rule.hasDisplay).length,
    missingFontDisplay: rules.filter((rule) => rule.hasSrc && !rule.hasDisplay).length,
    malformed,
    findings,
    parseErrors: [],
    policy,
    rules,
    root,
  };
}

function publicAnalysis(parsed: Parsed): CssAnalysis {
  return {
    fontFaceCount: parsed.fontFaceCount,
    withFontDisplay: parsed.withFontDisplay,
    missingFontDisplay: parsed.missingFontDisplay,
    malformed: parsed.malformed,
    findings: parsed.findings,
    parseErrors: parsed.parseErrors,
    policy: parsed.policy,
  };
}

/** Reports every `@font-face` rule and whether it declares `font-display`. Throws `CssInputError` for empty or oversized input. */
export function analyzeCss(css: string, policy: FontDisplayPolicy): CssAnalysis {
  return publicAnalysis(parseAndAnalyze(css, policy));
}

/**
 * Adds `font-display` to every `@font-face` rule that has a `src` and no
 * `font-display`. A stylesheet that does not parse is returned untouched:
 * patching text the parser could not model could produce invalid CSS.
 */
export function patchFontDisplay(css: string, policy: FontDisplayPolicy): CssPatch {
  const parsed = parseAndAnalyze(css, policy);
  const inputBytes = utf8Bytes(css);
  if (!parsed.root) {
    return { output: css, inputBytes, outputBytes: inputBytes, changedLines: [], rulesPatched: [], analysis: publicAnalysis(parsed) };
  }

  const rulesPatched: CssPatch["rulesPatched"] = [];
  for (const rule of parsed.rules) {
    if (!rule.hasSrc || rule.hasDisplay) continue;
    // Appended to the end of the block. PostCSS keeps the rule's own
    // indentation and semicolons, so the rest of the block is unchanged.
    rule.node.append(postcss.decl({ prop: "font-display", value: policy }));
    rulesPatched.push({ family: rule.family, line: rule.line, value: policy });
  }
  if (rulesPatched.length === 0) {
    return { output: css, inputBytes, outputBytes: inputBytes, changedLines: [], rulesPatched, analysis: publicAnalysis(parsed) };
  }

  const output = parsed.root.toString();
  // The lines that are new in the output: every output line that cannot be
  // matched to an input line with the same text.
  const remaining = new Map<string, number>();
  for (const line of css.split("\n")) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const changedLines: number[] = [];
  output.split("\n").forEach((line, index) => {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else changedLines.push(index + 1);
  });

  return { output, inputBytes, outputBytes: utf8Bytes(output), changedLines, rulesPatched, analysis: publicAnalysis(parsed) };
}

/** How many `@font-face` rules a stylesheet has, and how many of them lack `font-display`. Null when it does not parse. */
export function countFontDisplayGaps(css: string): { total: number; missing: number } | null {
  let parsed: Parsed;
  try {
    parsed = parseAndAnalyze(css, "swap");
  } catch {
    return { total: 0, missing: 0 };
  }
  return parsed.root ? { total: parsed.fontFaceCount, missing: parsed.missingFontDisplay } : null;
}
