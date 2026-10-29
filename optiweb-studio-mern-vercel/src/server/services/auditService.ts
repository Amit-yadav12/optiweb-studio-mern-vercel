/**
 * Website performance audit — HTML fetch + asset discovery.
 *
 * This is a *document-level lab measurement*, not a Chrome session and not
 * CrUX field data. JavaScript-inserted resources are not observed. When
 * PAGESPEED_API_KEY is set, PageSpeed Insights (lab + field) is attached and
 * labelled as such. Missing field data is reported as unavailable, never filled in.
 */
import { parse as parseHtml } from "node-html-parser";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as http from "node:http";
import * as https from "node:https";
import { limits } from "@/server/config/env";
import { badRequest, unprocessable } from "@/server/http/errors";
import { assertPublicHostname, assertPublicIp, parseHttpUrl, validateAuditUrl } from "@/server/security/ssrf";
import { sniffImage } from "@/server/services/imageService";
import { analyzeCss } from "@/server/services/cssService";

export type EvidenceKind = "measured" | "estimated" | "unavailable" | "not-applicable";

export type AuditResource = {
  url: string;
  kind: "document" | "image" | "stylesheet" | "font" | "script" | "other";
  origin: "document-html" | "stylesheet";
  status: number | null;
  contentType: string | null;
  transferredBytes: number | null;
  width: number | null;
  height: number | null;
  skipped?: string;
  finding?: string;
};

export type AuditFinding = {
  id: string;
  severity: "info" | "warning" | "issue";
  title: string;
  evidence: string;
  action: string;
  heuristic: boolean;
};

export type AuditReport = {
  url: string;
  fetchedUrl: string;
  startedAt: string;
  durationMs: number;
  coverage: {
    mode: "single-document";
    javascriptRendered: false;
    note: string;
  };
  document: {
    status: number;
    contentType: string | null;
    bytes: number;
    title: string | null;
  };
  resources: AuditResource[];
  totals: {
    requestsAttempted: number;
    requestsOk: number;
    transferredBytes: number;
    imageBytes: number;
    fontBytes: number;
    cssBytes: number;
    scriptBytes: number;
  };
  findings: AuditFinding[];
  pagespeed: {
    configured: boolean;
    lab: Record<string, { value: number | string | null; source: string; kind: EvidenceKind }> | null;
    field: Record<string, { value: number | string | null; source: string; kind: EvidenceKind }> | null;
    error?: string;
  };
};

const UA = "OptiWebStudio-Audit/1.0 (+https://optiweb.studio; lab document fetch)";

type PublicFetchResult = {
  status: number;
  contentType: string | null;
  body: Buffer;
  finalUrl: string;
  location?: string;
};

/**
 * Resolve again at the actual socket-creation boundary and pin the connection to
 * a validated public address. This narrows DNS-rebinding risk versus validating
 * DNS and then letting fetch resolve the hostname a second time.
 */
const pinnedPublicLookup: NonNullable<http.RequestOptions["lookup"]> = (hostname, options, callback) => {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  if (isIP(normalized)) {
    try {
      assertPublicIp(normalized);
      const address = { address: normalized, family: isIP(normalized) };
      if ("all" in options && options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    } catch {
      callback(Object.assign(new Error("Private network addresses cannot be audited."), { code: "EACCES" }), "", 0);
    }
    return;
  }

  void lookup(normalized, { all: true, verbatim: true }).then((records) => {
    if (records.length === 0) throw new Error("No DNS records were returned.");
    // Reject mixed public/private answers rather than selecting the public one
    // and accidentally permitting an ambiguous or rebinding DNS response.
    records.forEach((record) => assertPublicIp(record.address));
    if ("all" in options && options.all) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  }).catch(() => {
    callback(Object.assign(new Error("Public DNS resolution failed."), { code: "ENOTFOUND" }), "", 0);
  });
};

async function withinDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("AUDIT_TIMEOUT");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("AUDIT_TIMEOUT")), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requestPublicOnce(url: URL, maxBytes: number, timeoutMs: number): Promise<PublicFetchResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;

    const resolveOnce = (value: PublicFetchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const rejectOnce = (reason: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(reason);
    };

    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const requestOptions: http.RequestOptions = {
      hostname,
      port: url.port ? Number(url.port) : undefined,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: { accept: "*/*", "user-agent": UA, host: url.host },
      lookup: pinnedPublicLookup,
      maxHeaderSize: 16 * 1024,
    };

    const onResponse = (response: http.IncomingMessage) => {
      const status = response.statusCode ?? 0;
      const rawType = response.headers["content-type"];
      const contentType = typeof rawType === "string" ? rawType : null;
      const rawLocation = response.headers.location;
      const location = typeof rawLocation === "string" ? rawLocation : Array.isArray(rawLocation) ? rawLocation[0] : undefined;

      if (status >= 300 && status < 400) {
        response.destroy();
        resolveOnce({ status, contentType, body: Buffer.alloc(0), finalUrl: url.href, location });
        return;
      }

      const rawLength = response.headers["content-length"];
      const declared = typeof rawLength === "string" ? Number(rawLength) : NaN;
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy();
        request.destroy(new Error("AUDIT_SIZE_LIMIT"));
        rejectOnce(new Error("AUDIT_SIZE_LIMIT"));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > maxBytes) {
          response.destroy();
          request.destroy(new Error("AUDIT_SIZE_LIMIT"));
          rejectOnce(new Error("AUDIT_SIZE_LIMIT"));
          return;
        }
        chunks.push(bytes);
      });
      response.on("end", () => resolveOnce({
        status,
        contentType,
        body: Buffer.concat(chunks, size),
        finalUrl: url.href,
        location,
      }));
      response.on("error", (error) => rejectOnce(timedOut ? new Error("AUDIT_TIMEOUT") : error));
    };

    const request = url.protocol === "https:"
      ? https.request(requestOptions, onResponse)
      : http.request(requestOptions, onResponse);

    timer = setTimeout(() => {
      timedOut = true;
      request.destroy(new Error("AUDIT_TIMEOUT"));
    }, Math.max(1, timeoutMs));
    request.on("error", (error) => rejectOnce(timedOut ? new Error("AUDIT_TIMEOUT") : error));
    request.end();
  });
}

async function fetchPublic(
  url: URL,
  maxBytes: number,
  deadline: number,
  reserveMs = 0,
): Promise<{ status: number; contentType: string | null; body: Buffer; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= 3; hop += 1) {
    const remainingMs = deadline - Date.now() - reserveMs;
    if (remainingMs <= 100) throw unprocessable("The audit reached its overall time budget.", "Reduce the audit scope or retry with fewer resources.");
    try {
      await withinDeadline(assertPublicHostname(current.hostname), deadline - reserveMs);
    } catch (error) {
      if (error instanceof Error && error.message === "AUDIT_TIMEOUT") {
        throw unprocessable("The website audit reached its overall time budget while resolving DNS.", "Retry the audit or reduce its scope.");
      }
      throw error;
    }
    let response: PublicFetchResult;
    try {
      response = await requestPublicOnce(current, maxBytes, Math.min(limits.auditTimeoutMs, remainingMs));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "AUDIT_SIZE_LIMIT") {
        throw unprocessable(`The response is larger than the ${(maxBytes / 1024).toFixed(0)} KB audit limit.`);
      }
      if (message === "AUDIT_TIMEOUT") {
        throw unprocessable("The remote host exceeded the audit time budget.", "Try a faster public page or reduce the audit scope.");
      }
      throw unprocessable("The remote host could not be reached.", "Check the public URL and try again.");
    }

    if (response.status >= 300 && response.status < 400) {
      if (!response.location) throw unprocessable("The remote host returned a redirect without a Location header.");
      current = new URL(response.location, current);
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        throw badRequest("Redirected to a non-http URL.");
      }
      continue;
    }

    return {
      status: response.status,
      contentType: response.contentType,
      body: response.body,
      finalUrl: current.href,
    };
  }
  throw unprocessable("Too many redirects.");
}

function abs(from: URL, href: string | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("javascript:") || trimmed.startsWith("#")) return null;
  try {
    return new URL(trimmed, from).href;
  } catch {
    return null;
  }
}

function classify(url: string, contentType: string | null): AuditResource["kind"] {
  const path = url.toLowerCase();
  const type = (contentType ?? "").toLowerCase();
  if (type.startsWith("image/") || /\.(avif|gif|jpe?g|png|svg|webp|ico)(\?|$)/.test(path)) return "image";
  if (type.includes("css") || path.endsWith(".css")) return "stylesheet";
  if (type.includes("font") || /\.(woff2?|ttf|otf|eot)(\?|$)/.test(path)) return "font";
  if (type.includes("javascript") || /\.m?js(\?|$)/.test(path)) return "script";
  return "other";
}

async function pagespeed(url: string, timeoutMs: number) {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) {
    return {
      configured: false,
      lab: null,
      field: null,
      error: "PAGESPEED_API_KEY is not set. Lab Core Web Vitals from Lighthouse and CrUX field data are unavailable.",
    };
  }
  if (timeoutMs < 500) {
    return { configured: true, lab: null, field: null, error: "The overall audit time budget was reached before PageSpeed Insights could run." };
  }
  try {
    const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
    endpoint.searchParams.set("url", url);
    endpoint.searchParams.set("strategy", "mobile");
    endpoint.searchParams.set("key", key);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(Math.min(limits.auditPageSpeedTimeoutMs, timeoutMs)) });
    if (!response.ok) {
      return { configured: true, lab: null, field: null, error: `PageSpeed Insights returned HTTP ${response.status}.` };
    }
    const json = (await response.json()) as {
      lighthouseResult?: { audits?: Record<string, { numericValue?: number; displayValue?: string }> };
      loadingExperience?: { metrics?: Record<string, { percentile?: number; category?: string }> };
    };
    const audits = json.lighthouseResult?.audits ?? {};
    const lab = {
      lcp: { value: audits["largest-contentful-paint"]?.numericValue ?? null, source: "PageSpeed Insights Lighthouse (lab)", kind: "measured" as EvidenceKind },
      cls: { value: audits["cumulative-layout-shift"]?.numericValue ?? null, source: "PageSpeed Insights Lighthouse (lab)", kind: "measured" as EvidenceKind },
      tbt: { value: audits["total-blocking-time"]?.numericValue ?? null, source: "PageSpeed Insights Lighthouse (lab)", kind: "measured" as EvidenceKind },
    };
    const fieldMetrics = json.loadingExperience?.metrics;
    const field = fieldMetrics
      ? {
          lcp: { value: fieldMetrics.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null, source: "Chrome UX Report via PSI (field)", kind: "measured" as EvidenceKind },
          cls: { value: fieldMetrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile ?? null, source: "Chrome UX Report via PSI (field)", kind: "measured" as EvidenceKind },
          inp: { value: fieldMetrics.INTERACTION_TO_NEXT_PAINT?.percentile ?? null, source: "Chrome UX Report via PSI (field)", kind: "measured" as EvidenceKind },
        }
      : null;
    return {
      configured: true,
      lab,
      field: field ?? {
        lcp: { value: null, source: "Chrome UX Report", kind: "unavailable" as EvidenceKind },
      },
      error: field ? undefined : "CrUX has insufficient real-user data for this URL.",
    };
  } catch (error) {
    return {
      configured: true,
      lab: null,
      field: null,
      error: error instanceof Error ? error.message : "PageSpeed Insights request failed.",
    };
  }
}

export async function runWebsiteAudit(rawUrl: string): Promise<AuditReport> {
  const started = Date.now();
  const deadline = started + limits.auditTotalTimeoutMs;
  let url: URL;
  try {
    url = await withinDeadline(validateAuditUrl(rawUrl), deadline);
  } catch (error) {
    if (error instanceof Error && error.message === "AUDIT_TIMEOUT") {
      throw unprocessable("The website audit reached its overall time budget while resolving the page URL.", "Check the URL or retry later.");
    }
    throw error;
  }
  const document = await fetchPublic(url, limits.auditMaxHtmlBytes, deadline);
  if (document.status >= 400) {
    throw unprocessable(`The page returned HTTP ${document.status}.`);
  }

  const html = document.body.toString("utf8");
  const root = parseHtml(html);
  const title = root.querySelector("title")?.text?.trim() || null;
  const discovered = new Set<string>();

  const pushUrl = (href: string | null) => {
    if (!href) return;
    try {
      const resolved = new URL(href);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
      discovered.add(resolved.href);
    } catch {
      /* ignore */
    }
  };

  for (const img of root.querySelectorAll("img")) {
    pushUrl(abs(url, img.getAttribute("src")));
    const srcset = img.getAttribute("srcset") ?? "";
    for (const part of srcset.split(",")) pushUrl(abs(url, part.trim().split(/\s+/)[0]));
  }
  for (const source of root.querySelectorAll("source")) {
    pushUrl(abs(url, source.getAttribute("src")));
    const srcset = source.getAttribute("srcset") ?? "";
    for (const part of srcset.split(",")) pushUrl(abs(url, part.trim().split(/\s+/)[0]));
  }
  for (const link of root.querySelectorAll("link")) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase();
    if (rel.includes("stylesheet") || rel.includes("preload") || rel.includes("icon")) {
      pushUrl(abs(url, link.getAttribute("href")));
    }
  }
  for (const script of root.querySelectorAll("script[src]")) {
    pushUrl(abs(url, script.getAttribute("src")));
  }

  const resources: AuditResource[] = [
    {
      url: document.finalUrl,
      kind: "document",
      origin: "document-html",
      status: document.status,
      contentType: document.contentType,
      transferredBytes: document.body.byteLength,
      width: null,
      height: null,
    },
  ];

  const findings: AuditFinding[] = [];
  const queue = [...discovered].slice(0, limits.auditMaxResources);
  const psiReserveMs = process.env.PAGESPEED_API_KEY ? limits.auditPageSpeedTimeoutMs : 0;

  for (let resourceIndex = 0; resourceIndex < queue.length; resourceIndex += 1) {
    const href = queue[resourceIndex];
    if (deadline - Date.now() <= psiReserveMs + 150) {
      for (const remainingUrl of queue.slice(resourceIndex)) {
        resources.push({
          url: remainingUrl,
          kind: classify(remainingUrl, null),
          origin: "document-html",
          status: null,
          contentType: null,
          transferredBytes: null,
          width: null,
          height: null,
          skipped: "overall audit time budget reached",
        });
      }
      break;
    }
    let parsed: URL;
    try {
      parsed = parseHttpUrl(href);
    } catch {
      resources.push({
        url: href,
        kind: "other",
        origin: "document-html",
        status: null,
        contentType: null,
        transferredBytes: null,
        width: null,
        height: null,
        skipped: "invalid URL",
      });
      continue;
    }
    try {
      const fetched = await fetchPublic(parsed, limits.auditMaxResourceBytes, deadline, psiReserveMs);
      const kind = classify(fetched.finalUrl, fetched.contentType);
      let width: number | null = null;
      let height: number | null = null;
      let finding: string | undefined;
      if (kind === "image") {
        try {
          const sniffed = await sniffImage(fetched.body);
          width = sniffed.width;
          height = sniffed.height;
          if (fetched.body.byteLength > 300 * 1024) {
            finding = `Image is ${(fetched.body.byteLength / 1024).toFixed(0)} KB. Test a WebP/AVIF conversion in the Image Optimizer.`;
          }
        } catch {
          finding = "Image bytes could not be decoded.";
        }
      }
      if (kind === "stylesheet") {
        try {
          const analysis = analyzeCss(fetched.body.toString("utf8"), "swap");
          if (analysis.missingFontDisplay > 0) {
            finding = `${analysis.missingFontDisplay} of ${analysis.fontFaceCount} @font-face rules lack font-display.`;
          }
        } catch {
          finding = "Stylesheet could not be parsed.";
        }
      }
      resources.push({
        url: fetched.finalUrl,
        kind,
        origin: "document-html",
        status: fetched.status,
        contentType: fetched.contentType,
        transferredBytes: fetched.body.byteLength,
        width,
        height,
        finding,
      });
      if (finding) {
        findings.push({
          id: crypto.randomUUID(),
          severity: kind === "image" ? "warning" : "info",
          title: finding,
          evidence: `${fetched.finalUrl} · ${fetched.body.byteLength} bytes · HTTP ${fetched.status}`,
          action:
            kind === "image"
              ? "Download the image and run it through the Image Optimizer, or re-export at the displayed size."
              : "Open the Font Optimizer with this stylesheet.",
          heuristic: kind === "image",
        });
      }
    } catch (error) {
      resources.push({
        url: href,
        kind: classify(href, null),
        origin: "document-html",
        status: null,
        contentType: null,
        transferredBytes: null,
        width: null,
        height: null,
        skipped: error instanceof Error ? error.message : "fetch failed",
      });
    }
  }

  const ok = resources.filter((r) => r.status && r.status < 400);
  const transferred = ok.reduce((sum, r) => sum + (r.transferredBytes ?? 0), 0);
  const psi = await pagespeed(document.finalUrl, deadline - Date.now());

  findings.unshift({
    id: "coverage",
    severity: "info",
    title: "This is a document-level lab fetch, not a browser session.",
    evidence: `HTML parsed for ${queue.length} discoverable URLs. JavaScript-inserted resources are not observed.`,
    action: "Treat Core Web Vitals as unavailable unless PageSpeed Insights is configured.",
    heuristic: false,
  });

  return {
    url: url.href,
    fetchedUrl: document.finalUrl,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    coverage: {
      mode: "single-document",
      javascriptRendered: false,
      note: "Assets listed in the initial HTML and same-document srcset/src/href. No headless Chrome, so client-rendered resources are out of scope.",
    },
    document: {
      status: document.status,
      contentType: document.contentType,
      bytes: document.body.byteLength,
      title,
    },
    resources,
    totals: {
      requestsAttempted: resources.length,
      requestsOk: ok.length,
      transferredBytes: transferred,
      imageBytes: ok.filter((r) => r.kind === "image").reduce((s, r) => s + (r.transferredBytes ?? 0), 0),
      fontBytes: ok.filter((r) => r.kind === "font").reduce((s, r) => s + (r.transferredBytes ?? 0), 0),
      cssBytes: ok.filter((r) => r.kind === "stylesheet").reduce((s, r) => s + (r.transferredBytes ?? 0), 0),
      scriptBytes: ok.filter((r) => r.kind === "script").reduce((s, r) => s + (r.transferredBytes ?? 0), 0),
    },
    findings,
    pagespeed: psi,
  };
}
