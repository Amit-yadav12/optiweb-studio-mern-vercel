/**
 * Asset analysis: what a file's own bytes say about it.
 *
 * Every finding states its evidence and a recommendation, and says whether it
 * rests on a threshold (a heuristic) or on a fact read from the file. The
 * analysis sees only the file: it cannot know how a page uses it.
 *
 * Images are read from their headers and never decoded. The module has no
 * dependency on a browser or on Node, so the same code serves both.
 */
import { analyzeCss, CssInputError } from "./css";
import { displayedSize, readImageHeader, type ImageFormat, type ImageHeader } from "./imageHeader";

export type AssetSeverity = "info" | "warning" | "issue";

export type AssetFindingCode =
  | "large-file"
  | "oversized-dimensions"
  | "format-advice"
  | "animated"
  | "location-data"
  | "name-mismatch"
  | "damaged"
  | "vector"
  | "svg-script"
  | "font-display-missing"
  | "font-display-ok"
  | "no-font-face"
  | "css-syntax"
  | "css-too-large"
  | "unrecognised";

export type AssetFinding = {
  id: string;
  code: AssetFindingCode;
  severity: AssetSeverity;
  /** What was measured or read. */
  evidence: string;
  /** What to do about it. */
  recommendation: string;
  /** True when the finding compares the file against a threshold instead of stating a fact. */
  heuristic: boolean;
};

export type AssetReport = {
  id: string;
  filename: string;
  bytes: number;
  kind: "image" | "css" | "other";
  /** Detected from the file's contents. Null when the contents were not recognised. */
  format: ImageFormat | "css" | null;
  width: number | null;
  height: number | null;
  /** Facts about the file, in words: "8-bit palette", "progressive", "EXIF", … */
  facts: string[];
  /** True when the Image Optimizer can take this file. */
  optimizable: boolean;
  findings: AssetFinding[];
};

export type AssetAnalysis = {
  files: AssetReport[];
  summary: { filesScanned: number; findings: number; warnings: number; issues: number; heuristicsUsed: boolean };
};

export type AssetInput = {
  filename: string;
  /** Size of the whole file in bytes. */
  bytes: number;
  /** The start of the file. One megabyte is enough for every format; a GIF needs all of it for a frame count. */
  head: Uint8Array;
  /** The whole file as text. Supplied for stylesheets only. */
  text?: string | null;
};

export const DEFAULT_THRESHOLD_KB = 300;
/** A side longer than this is reported as possibly larger than any layout needs. */
export const LARGE_SIDE_PX = 1920;

const FORMAT_NAME: Record<ImageFormat, string> = {
  jpeg: "JPEG",
  png: "PNG",
  gif: "GIF",
  webp: "WebP",
  avif: "AVIF",
  heic: "HEIC",
  tiff: "TIFF",
  bmp: "BMP",
  ico: "ICO",
  svg: "SVG",
};

const NAME_FORMAT: Record<string, ImageFormat> = {
  jpg: "jpeg",
  jpeg: "jpeg",
  jfif: "jpeg",
  png: "png",
  apng: "png",
  gif: "gif",
  webp: "webp",
  avif: "avif",
  heic: "heic",
  heif: "heic",
  tif: "tiff",
  tiff: "tiff",
  bmp: "bmp",
  ico: "ico",
  svg: "svg",
};

const FORMAT_ADVICE: Partial<Record<ImageFormat, { severity: AssetSeverity; evidence: string; recommendation: string }>> = {
  jpeg: {
    severity: "info",
    evidence: "JPEG file.",
    recommendation: "Re-encoding a photograph as WebP or AVIF usually reduces its weight. Run it through the Image Optimizer to measure the difference for this file.",
  },
  png: {
    severity: "info",
    evidence: "PNG file. PNG is lossless.",
    recommendation: "For a photograph or other opaque artwork, WebP or JPEG is often several times smaller. For flat graphics with few colours, PNG can already be the smallest: measure it in the Image Optimizer.",
  },
  gif: {
    severity: "warning",
    evidence: "GIF file. GIF is limited to 256 colours.",
    recommendation: "For a still image use PNG or WebP. For animation, a video (MP4 or WebM) is normally far lighter.",
  },
  tiff: {
    severity: "warning",
    evidence: "TIFF file. TIFF is a print and interchange format.",
    recommendation: "Only Safari displays TIFF. Convert it to WebP, AVIF or JPEG before publishing it on a page.",
  },
  bmp: {
    severity: "warning",
    evidence: "BMP file. BMP stores pixels without compression.",
    recommendation: "Convert it to WebP, AVIF, JPEG or PNG. Any of them is many times smaller.",
  },
  heic: {
    severity: "warning",
    evidence: "HEIC file.",
    recommendation: "Only Safari displays HEIC. Export the photo as JPEG, or convert it to WebP or AVIF, before publishing it on a page.",
  },
  webp: { severity: "info", evidence: "WebP file, a modern delivery format.", recommendation: "What is left to gain is usually in the dimensions and the quality setting." },
  avif: { severity: "info", evidence: "AVIF file, currently the most efficient widely supported delivery format.", recommendation: "What is left to gain is usually in the dimensions." },
};

function kb(bytes: number): string {
  return bytes >= 10 * 1024 ? `${Math.round(bytes / 1024).toLocaleString("en-US")} KB` : `${(bytes / 1024).toFixed(1)} KB`;
}

function isStylesheet(input: AssetInput): boolean {
  return /\.css$/i.test(input.filename);
}

function imageFacts(header: ImageHeader): string[] {
  const facts = [...header.traits];
  if (header.hasAlpha) facts.push("can carry transparency");
  const metadata = [header.metadata.exif ? "EXIF" : null, header.metadata.xmp ? "XMP" : null, header.metadata.icc ? "colour profile" : null].filter(Boolean);
  if (metadata.length > 0) facts.push(`metadata: ${metadata.join(", ")}`);
  return facts;
}

function analyzeImage(input: AssetInput, header: ImageHeader, thresholdKb: number, id: string): AssetReport {
  const label = FORMAT_NAME[header.format];
  const shown = displayedSize(header);
  const findings: AssetFinding[] = [];
  const add = (code: AssetFindingCode, severity: AssetSeverity, evidence: string, recommendation: string, heuristic = false) =>
    findings.push({ id: `${id}:${code}`, code, severity, evidence, recommendation, heuristic });

  const extension = /\.([a-z0-9]+)$/i.exec(input.filename)?.[1]?.toLowerCase();
  const named = extension ? NAME_FORMAT[extension] : undefined;
  if (named && named !== header.format) {
    add(
      "name-mismatch",
      "warning",
      `The name ends in .${extension}, but the contents are ${label}.`,
      "Rename the file to match its contents. A server that picks the Content-Type from the extension would declare the wrong type for it.",
    );
  }

  if (header.malformed) {
    add("damaged", "issue", `The file starts like a ${label}, but ${header.malformed}.`, "The file is probably incomplete or damaged. Export it again from the source.");
    return { id, filename: input.filename, bytes: input.bytes, kind: "image", format: header.format, width: null, height: null, facts: [], optimizable: false, findings };
  }

  if (header.format === "svg") {
    add("vector", "info", "SVG is a text-based vector format.", "Serve it as SVG, minified and compressed. Turning it into pixels would usually add weight.");
    if (header.traits.includes("contains script")) {
      add("svg-script", "warning", "The SVG contains a <script> element.", "A script in an SVG runs when the file is opened directly or embedded with <object>. Remove it unless the image needs it, and never accept such files from users.");
    }
  } else {
    if (input.bytes > thresholdKb * 1024) {
      add("large-file", "warning", `The file is ${kb(input.bytes)}, above the ${thresholdKb} KB threshold set in Settings.`, "Optimize it, and consider a smaller width so it is not delivered larger than any layout shows it.", true);
    }
    if ((shown.width ?? 0) > LARGE_SIDE_PX || (shown.height ?? 0) > LARGE_SIDE_PX) {
      add(
        "oversized-dimensions",
        "warning",
        `The image is ${shown.width} × ${shown.height} px. One side is longer than ${LARGE_SIDE_PX.toLocaleString("en-US")} px.`,
        "If no layout shows it that large, set a maximum width in the Image Optimizer. The file alone cannot say how large it is shown: check the page.",
        true,
      );
    }
    if (header.animated) {
      add(
        "animated",
        header.format === "gif" ? "warning" : "info",
        header.frames ? `The file is animated: ${header.frames} frames.` : "The file is an image sequence.",
        header.format === "gif" ? "An animated GIF is usually many times larger than the same clip as MP4 or WebM video." : "The Image Optimizer writes still images only, so it does not convert animations.",
      );
    }
    if (header.metadata.gps) {
      add(
        "location-data",
        "warning",
        "The file's EXIF metadata contains a GPS block: where the photo was taken.",
        "Published as it is, the file reveals that location to anyone who downloads it. Files written by the Image Optimizer carry no metadata.",
      );
    }
    const advice = FORMAT_ADVICE[header.format];
    if (advice) add("format-advice", advice.severity, advice.evidence, advice.recommendation);
  }

  return {
    id,
    filename: input.filename,
    bytes: input.bytes,
    kind: "image",
    format: header.format,
    width: shown.width,
    height: shown.height,
    facts: imageFacts(header),
    optimizable: header.format !== "svg" && !header.animated,
    findings,
  };
}

function analyzeStylesheet(input: AssetInput, thresholdKb: number, id: string): AssetReport {
  const findings: AssetFinding[] = [];
  const add = (code: AssetFindingCode, severity: AssetSeverity, evidence: string, recommendation: string, heuristic = false) =>
    findings.push({ id: `${id}:${code}`, code, severity, evidence, recommendation, heuristic });
  const facts: string[] = [];

  if (input.bytes > thresholdKb * 1024) {
    add("large-file", "warning", `The stylesheet is ${kb(input.bytes)}, above the ${thresholdKb} KB threshold set in Settings.`, "Look for rules no page uses. The Font Optimizer only adds font-display; it does not remove selectors.", true);
  }

  if (input.text === undefined || input.text === null) {
    add("css-too-large", "info", "The stylesheet is too large to parse in the browser.", "Split it, or analyse the part that holds the @font-face rules.");
  } else {
    try {
      const analysis = analyzeCss(input.text, "swap");
      if (analysis.parseErrors.length > 0) {
        const first = analysis.parseErrors[0];
        add("css-syntax", "issue", `The stylesheet does not parse. Line ${first.line}: ${first.reason}.`, "Fix the syntax error, then analyse again.");
      } else if (analysis.fontFaceCount === 0) {
        facts.push("no @font-face rules");
        add("no-font-face", "info", "The stylesheet has no @font-face rules.", "Webfonts loaded from a third-party stylesheet need that stylesheet analysed instead.");
      } else {
        facts.push(`${analysis.fontFaceCount} @font-face rule${analysis.fontFaceCount === 1 ? "" : "s"}`);
        if (analysis.missingFontDisplay > 0) {
          add(
            "font-display-missing",
            "warning",
            `${analysis.missingFontDisplay} of ${analysis.fontFaceCount} @font-face rules do not declare font-display.`,
            "Text set in those fonts can stay invisible while they download. Open the Font Optimizer to review the patch before applying it.",
          );
        } else {
          add("font-display-ok", "info", `All ${analysis.fontFaceCount} @font-face rules declare font-display.`, "Nothing to patch: the font loading policy is explicit.");
        }
      }
    } catch (error) {
      if (error instanceof CssInputError && error.code === "empty") add("css-syntax", "info", "The stylesheet is empty.", "There is nothing to analyse.");
      else add("css-too-large", "info", error instanceof Error ? error.message : "The stylesheet could not be analysed.", "Split it, or analyse the part that holds the @font-face rules.");
    }
  }

  return { id, filename: input.filename, bytes: input.bytes, kind: "css", format: "css", width: null, height: null, facts, optimizable: false, findings };
}

/** Analyses each file on its own. Never throws for a file's contents: a file that cannot be read becomes a finding. */
export function analyzeAssets(files: readonly AssetInput[], options: { thresholdKb?: number } = {}): AssetAnalysis {
  const thresholdKb = options.thresholdKb && options.thresholdKb > 0 ? options.thresholdKb : DEFAULT_THRESHOLD_KB;
  const reports = files.map((input, index): AssetReport => {
    const id = `asset-${index}`;
    const header = input.bytes > 0 ? readImageHeader(input.head) : null;
    // Contents decide. A stylesheet is recognised by its name only when the contents are not an image.
    if (header) return analyzeImage(input, header, thresholdKb, id);
    if (isStylesheet(input)) return analyzeStylesheet(input, thresholdKb, id);
    return {
      id,
      filename: input.filename,
      bytes: input.bytes,
      kind: "other",
      format: null,
      width: null,
      height: null,
      facts: [],
      optimizable: false,
      findings: [
        {
          id: `${id}:unrecognised`,
          code: "unrecognised",
          severity: "issue",
          evidence: input.bytes === 0 ? "The file is empty." : "The contents are neither an image format this tool reads nor a .css file.",
          recommendation: "Select JPEG, PNG, WebP, AVIF, GIF, TIFF, BMP, HEIC or SVG images, or a stylesheet whose name ends in .css.",
          heuristic: false,
        },
      ],
    };
  });

  const all = reports.flatMap((report) => report.findings);
  return {
    files: reports,
    summary: {
      filesScanned: reports.length,
      findings: all.filter((finding) => finding.severity !== "info").length,
      warnings: all.filter((finding) => finding.severity === "warning").length,
      issues: all.filter((finding) => finding.severity === "issue").length,
      heuristicsUsed: all.some((finding) => finding.heuristic),
    },
  };
}
