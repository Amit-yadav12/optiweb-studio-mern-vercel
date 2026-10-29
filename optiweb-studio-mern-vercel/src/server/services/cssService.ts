/**
 * CSS font-display analysis and patching, built on PostCSS.
 *
 * Safety rules:
 * - The stylesheet is parsed, not regex-split, so malformed input is reported
 *   with a line number instead of producing a broken file.
 * - `font-display` is only ever inserted into an `@font-face` rule that already
 *   parses cleanly and declares a `src`.
 * - Everything the tool does not understand is left byte-for-byte untouched.
 */
import postcss, { type AtRule } from "postcss";
import { limits, type FontDisplayPolicy } from "@/server/config/env";
import { badRequest, unprocessable } from "@/server/http/errors";
import type { CssAnalysis, CssFinding, CssPatchResponse } from "@/types/domain";

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

type FontFaceRule = { node: AtRule; family: string | null; line: number; hasDisplay: boolean; hasSrc: boolean; value: string | null };

function collectFontFaceRules(root: postcss.Root): FontFaceRule[] {
  const rules: FontFaceRule[] = [];
  root.walkAtRules("font-face", (node) => {
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
    rules.push({
      node,
      family,
      line: node.source?.start?.line ?? 0,
      hasDisplay,
      hasSrc,
      value,
    });
  });
  return rules;
}

export type CssAnalysisResult = CssAnalysis & { rules: FontFaceRule[]; root: postcss.Root | null };

export function analyzeCss(css: string, policy: FontDisplayPolicy): CssAnalysisResult {
  if (!css.trim()) throw badRequest("No CSS supplied.");
  if (css.length > limits.maxCssChars) {
    throw unprocessable(`CSS is larger than the ${Math.round(limits.maxCssChars / 1000)}k character limit.`);
  }

  const findings: CssFinding[] = [];
  let parseErrors: Array<{ line: number; reason: string }> = [];
  let root: postcss.Root;

  try {
    root = postcss.parse(css, { from: "input.css" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown parse error";
    const lineMatch = /(\d+):\s*(\d+)/.exec(message);
    parseErrors = [
      {
        line: lineMatch ? Number(lineMatch[2]) : 1,
        reason: message.replace(/^.*?postcss:\s*/, "").slice(0, 200),
      },
    ];
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
          detail: `${message.slice(0, 240)} Nothing was changed. Fix the syntax error and analyse again.`,
          line: parseErrors[0].line,
        },
      ],
      parseErrors,
      policy,
      rules: [],
      root: null,
    };
  }

  const rules = collectFontFaceRules(root);
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

  for (const rule of rules) {
    const label = rule.family ? `@font-face for “${rule.family}”` : "@font-face rule";
    if (!rule.hasSrc) {
      malformed += 1;
      findings.push({
        id: `no-src-${rule.line}`,
        severity: "issue",
        code: "font-face-no-src",
        title: `${label} has no src descriptor`,
        detail: "Without `src` the browser cannot load the font. OptiWeb does not patch rules it cannot validate.",
        line: rule.line,
      });
      continue;
    }
    if (rule.hasDisplay) {
      findings.push({
        id: `has-display-${rule.line}`,
        severity: "info",
        code: "font-display-present",
        title: `${label} already declares font-display: ${rule.value}`,
        detail:
          rule.value?.toLowerCase() === policy
            ? `This already matches the selected ${policy} policy.`
            : `Selecting a different policy would rewrite this declaration. Nothing is changed without your confirmation.`,
        line: rule.line,
        selector: label,
      });
    } else {
      findings.push({
        id: `missing-display-${rule.line}`,
        severity: "warning",
        code: "font-display-missing",
        title: `${label} is missing font-display`,
        detail: `The browser falls back to its default behaviour, which blocks text rendering while the font downloads. Adding \`font-display: ${policy}\` makes the fallback visible immediately.`,
        line: rule.line,
        selector: label,
      });
    }
  }

  return {
    fontFaceCount: rules.length,
    withFontDisplay: rules.filter((r) => r.hasDisplay).length,
    missingFontDisplay: rules.filter((r) => r.hasSrc && !r.hasDisplay).length,
    malformed,
    findings,
    parseErrors,
    policy,
    rules,
    root,
  };
}

/**
 * Inserts `font-display` into every eligible `@font-face` rule. The returned
 * `changedLines` are the source line numbers of the inserted declarations so the
 * UI can highlight exactly what moved.
 */
/** Service-level shape: the controller adds job/artifact/persistence fields. */
export type CssPatchResult = Omit<CssPatchResponse, "jobId" | "artifactId" | "persisted">;

export function patchFontDisplay(css: string, policy: FontDisplayPolicy): CssPatchResult {
  const analysis = analyzeCss(css, policy);
  const inputBytes = Buffer.byteLength(css, "utf8");

  // A stylesheet that does not parse is returned untouched: patching text the
  // parser could not model would risk producing invalid CSS.
  if (!analysis.root) {
    return {
      output: css,
      inputBytes,
      outputBytes: inputBytes,
      changedLines: [],
      rulesPatched: [],
      analysis: {
        fontFaceCount: 0,
        withFontDisplay: 0,
        missingFontDisplay: 0,
        malformed: 0,
        findings: analysis.findings,
        parseErrors: analysis.parseErrors,
        policy,
      },
    };
  }

  const root = analysis.root;
  const changedLines: number[] = [];
  const rulesPatched: CssPatchResult["rulesPatched"] = [];
  const targets = analysis.rules.filter((rule) => rule.hasSrc && !rule.hasDisplay);

  root.walkAtRules("font-face", (node: AtRule) => {
    const match = targets.find((rule) => rule.node === node);
    if (!match) return;
    // Appended to the end of the block; postcss keeps the rule's original
    // indentation and semicolon raws intact.
    node.append(postcss.decl({ prop: "font-display", value: policy }));
    rulesPatched.push({ family: match.family, line: match.line, value: policy });
  });

  const output = root.toString();
  // The UI highlights the new lines in the produced stylesheet, so the diff is
  // computed against the output lines using a multiset comparison.
  const remaining = new Map<string, number>();
  for (const line of css.split("\n")) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  output.split("\n").forEach((line, index) => {
    const count = remaining.get(line) ?? 0;
    if (count > 0) {
      remaining.set(line, count - 1);
      return;
    }
    changedLines.push(index + 1);
  });

  return {
    output,
    inputBytes,
    outputBytes: Buffer.byteLength(output, "utf8"),
    changedLines,
    rulesPatched,
    analysis: {
      fontFaceCount: analysis.fontFaceCount,
      withFontDisplay: analysis.withFontDisplay,
      missingFontDisplay: analysis.missingFontDisplay,
      malformed: analysis.malformed,
      findings: analysis.findings,
      parseErrors: analysis.parseErrors,
      policy,
    },
  };
}

/** Used by the asset analyzer when a stylesheet is uploaded alongside images. */
export function countFontDisplayGaps(css: string): { total: number; missing: number } {
  const analysis = analyzeCss(css, "swap");
  return { total: analysis.fontFaceCount, missing: analysis.missingFontDisplay };
}
