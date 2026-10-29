/**
 * Asset analyzer — evidence-based diagnostics for uploaded files.
 *
 * Every finding states its evidence, its recommendation, and whether it comes
 * from a heuristic (a threshold) or a hard fact (parsed metadata). The analyzer
 * never infers page usage: it only sees the file you give it.
 */
import sharp from "sharp";
import { limits } from "@/server/config/env";
import { sniffImage } from "@/server/services/imageService";
import { countFontDisplayGaps } from "@/server/services/cssService";
import type { AssetAnalysisFile, AssetFinding, AssetAnalysisResponse } from "@/types/domain";

const FORMAT_ADVICE: Record<string, { severity: AssetFinding["severity"]; title: string; detail: string }> = {
  jpeg: {
    severity: "info",
    title: "JPEG source detected",
    detail:
      "Re-encoding to WebP or AVIF usually reduces photographic weight substantially. Run the file through the Image Optimizer to measure the real difference for this asset.",
  },
  png: {
    severity: "warning",
    title: "PNG source detected",
    detail:
      "PNG is lossless, so photographic or opaque artwork is often several times larger than a lossy equivalent. If the image has no transparency, test WebP or JPEG.",
  },
  gif: {
    severity: "warning",
    title: "GIF source detected",
    detail:
      "GIF is limited to 256 colours. For still images use PNG or WebP; for animation, video or animated WebP is normally far lighter.",
  },
  tiff: {
    severity: "warning",
    title: "TIFF source detected",
    detail: "TIFF is a print/interchange format and is not delivered to browsers. Convert to WebP, AVIF or JPEG.",
  },
  webp: {
    severity: "info",
    title: "Already a modern format",
    detail: "WebP is a good delivery format. Remaining wins are usually dimension and quality tuning.",
  },
  avif: {
    severity: "info",
    title: "Already a modern format",
    detail: "AVIF is currently the most efficient widely supported delivery format.",
  },
};

export type AnalyzerInput = {
  filename: string;
  contentType: string;
  buffer: Buffer;
};

function finding(
  file: AnalyzerInput,
  code: AssetFinding["code"],
  severity: AssetFinding["severity"],
  evidence: string,
  recommendation: string,
  heuristic = false,
): AssetFinding {
  return {
    id: `${file.filename}:${code}`,
    filename: file.filename,
    severity,
    code,
    evidence,
    recommendation,
    heuristic,
  };
}

export type AssetAnalysisResult = Omit<AssetAnalysisResponse, "jobId" | "persisted">;

export async function analyzeAssets(
  files: AnalyzerInput[],
  options: { thresholdKb: number },
): Promise<AssetAnalysisResult> {
  const analyzed: AssetAnalysisFile[] = [];

  for (const file of files) {
    const isCss =
      file.contentType.includes("css") || file.filename.toLowerCase().endsWith(".css");

    if (isCss) {
      analyzed.push(await analyzeCssFile(file, options.thresholdKb));
      continue;
    }

    try {
      const sniffed = await sniffImage(file.buffer);
      analyzed.push(await analyzeImageFile(file, sniffed, options.thresholdKb));
    } catch (error) {
      analyzed.push({
        id: crypto.randomUUID(),
        filename: file.filename,
        contentType: file.contentType,
        bytes: file.buffer.byteLength,
        kind: "other",
        width: null,
        height: null,
        format: null,
        findings: [
          finding(
            file,
            "no-findings",
            "issue",
            error instanceof Error ? error.message : "The file could not be decoded.",
            "Export the asset as JPEG, PNG, WebP, AVIF or GIF, or upload a .css file for font analysis.",
          ),
        ],
        error: error instanceof Error ? error.message : "unreadable",
      });
    }
  }

  const findings = analyzed.reduce((sum, file) => sum + file.findings.length, 0);
  return {
    files: analyzed,
    summary: {
      filesScanned: analyzed.length,
      findings,
      heuristicsUsed: analyzed.some((file) => file.findings.some((f) => f.heuristic)),
    },
  };
}

async function analyzeImageFile(
  file: AnalyzerInput,
  sniffed: Awaited<ReturnType<typeof sniffImage>>,
  thresholdKb: number,
): Promise<AssetAnalysisFile> {
  const bytes = file.buffer.byteLength;
  const thresholdBytes = thresholdKb * 1024;
  const findings: AssetFinding[] = [];

  findings.push(
    finding(
      file,
      "no-findings",
      "info",
      `${sniffed.format.toUpperCase()} · ${sniffed.width ?? "?"}×${sniffed.height ?? "?"} · ${(bytes / 1024).toFixed(1)} KB`,
      sniffed.isSvg
        ? "Vector source — serve as SVG and minify; raster conversion would add weight."
        : "Run this file through the Image Optimizer to measure real savings at your chosen quality.",
    ),
  );

  if (sniffed.isSvg) {
    findings.push(
      finding(
        file,
        "svg-not-processed",
        "info",
        "SVG is a text-based vector format.",
        "OptiWeb does not rasterise SVG. Minify it with an SVG-specific tool and serve it compressed.",
      ),
    );
    return {
      id: crypto.randomUUID(),
      filename: file.filename,
      contentType: file.contentType,
      bytes,
      kind: "image",
      width: sniffed.width,
      height: sniffed.height,
      format: sniffed.format,
      findings: findings.slice(0, 1).concat(findings.slice(1)),
    };
  }

  if (bytes > thresholdBytes) {
    findings.push(
      finding(
        file,
        "large-file",
        "warning",
        `File is ${(bytes / 1024).toFixed(0)} KB, above the ${thresholdKb} KB threshold configured in Settings.`,
        "Optimize this asset and consider a responsive width so it is not delivered larger than needed.",
        true,
      ),
    );
  }

  if ((sniffed.width ?? 0) > 1920 || (sniffed.height ?? 0) > 1920) {
    findings.push(
      finding(
        file,
        "oversized-dimensions",
        "warning",
        `Intrinsic size is ${sniffed.width}×${sniffed.height}px.`,
        "If the largest rendered size is smaller, cap max-width/max-height in the optimizer. This file alone cannot tell us the rendered size — check your layout.",
        true,
      ),
    );
  }

  const advice = FORMAT_ADVICE[sniffed.format];
  if (advice) {
    const code: AssetFinding["code"] =
      sniffed.format === "png" ? "png-for-photo" : sniffed.format === "jpeg" ? "format-conversion" : "format-conversion";
    findings.push(finding(file, code, advice.severity, `${sniffed.format.toUpperCase()} container.`, advice.detail));
  }

  return {
    id: crypto.randomUUID(),
    filename: file.filename,
    contentType: file.contentType,
    bytes,
    kind: "image",
    width: sniffed.width,
    height: sniffed.height,
    format: sniffed.format,
    findings,
  };
}

async function analyzeCssFile(file: AnalyzerInput, thresholdKb: number): Promise<AssetAnalysisFile> {
  const text = file.buffer.toString("utf8");
  const bytes = file.buffer.byteLength;
  const findings: AssetFinding[] = [];

  if (bytes > thresholdKb * 1024) {
    findings.push(
      finding(
        file,
        "large-file",
        "warning",
        `Stylesheet is ${(bytes / 1024).toFixed(0)} KB.`,
        "Audit for unused rules; the OptiWeb CSS tool only patches font-display, it does not purge selectors.",
        true,
      ),
    );
  }

  try {
    const { total, missing } = countFontDisplayGaps(text);
    if (total === 0) {
      findings.push(
        finding(
          file,
          "no-findings",
          "info",
          "No @font-face rules in this stylesheet.",
          "Webfonts loaded from a third-party stylesheet need that CSS analysed directly.",
        ),
      );
    } else if (missing > 0) {
      findings.push(
        finding(
          file,
          "font-display-missing",
          "warning",
          `${missing} of ${total} @font-face rules do not declare font-display.`,
          "Open the Font Optimizer to review the proposed patch before applying it.",
        ),
      );
    } else {
      findings.push(
        finding(
          file,
          "no-findings",
          "info",
          `All ${total} @font-face rules declare font-display.`,
          "Nothing to patch — the font loading policy is explicit.",
        ),
      );
    }
  } catch (error) {
    findings.push(
      finding(
        file,
        "css-syntax",
        "issue",
        error instanceof Error ? error.message : "The stylesheet could not be parsed.",
        "Fix the syntax error, then analyse again.",
      ),
    );
  }

  return {
    id: crypto.randomUUID(),
    filename: file.filename,
    contentType: file.contentType,
    bytes,
    kind: "css",
    width: null,
    height: null,
    format: "css",
    findings,
  };
}

