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
import { limits } from "../config/env.js";
import { badRequest, unprocessable } from "../http/errors.js";
import { assertPublicHostname, assertPublicIp, parseHttpUrl, validateAuditUrl } from "../security/ssrf.js";
import { readImageHeader, displayedSize } from "../../shared/imageHeader.js";
import { countFontDisplayGaps } from "../../shared/css.js";

export type EvidenceKind = "measured" | "estimated" | "unavailable" | "not-applicable";

export type AuditResource = {
  url: string;
  /** The page whose HTML named this resource first. For a document, the document itself. */
  page: string;
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

/** One inspected page: measurements of its initial HTML document. */
export type AuditPage = {
  url: string;
  status: number;
  contentType: string | null;
  bytes: number;
  title: string | null;
  /** Resource URLs found in this page's HTML, before the per-page limit. */
  resourcesFound: number;
  /** Of those, how many were requested for this page. A resource shared with an earlier page is requested once. */
  resourcesRequested: number;
};

export type AuditReport = {
  url: string;
  fetchedUrl: string;
  startedAt: string;
  durationMs: number;
  coverage: {
    mode: "single-document" | "multi-document";
    javascriptRendered: false;
    note: string;
    pagesRequested: number;
    pagesInspected: number;
    /** The limits this audit ran under. */
    limits: { maxPages: number; maxResourcesPerPage: number; maxDocumentBytes: number; maxResourceBytes: number; maxTotalBytes: number; timeBudgetMs: number; concurrency: number };
    /** Limits that cut the audit short, in words. Empty when it ran to its end. */
    stoppedBy: string[];
  };
  /** Every inspected page, the requested one first. */
  pages: AuditPage[];
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

const UA = "UnikitStudio-Audit/2.0 (static page audit; fetches the HTML document and the assets it names)";

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

    const timer = setTimeout(() => {
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

/** Fetches one public URL, with a size limit and a deadline. The default refuses private and reserved destinations. */
export type AuditFetcher = (url: URL, maxBytes: number, deadline: number, reserveMs?: number) => Promise<{ status: number; contentType: string | null; body: Buffer; finalUrl: string }>;

type Fetched = Awaited<ReturnType<AuditFetcher>>;
type EntryDocument = { finalUrl: string; status: number; contentType: string | null; bytes: number; title: string | null };

export type AuditOptions = {
  /** Same-origin pages to inspect in addition to the requested one. Bounded by the configured page limit. */
  extraPages?: number;
  /**
   * Replaces the network layer in tests. Production code never passes these:
   * the defaults validate every destination, and every redirect, against
   * private and reserved addresses.
   */
  fetcher?: AuditFetcher;
  validateUrl?: (raw: string) => Promise<URL>;
};

/** Extensions that are never an HTML page, so a link to them is not followed as one. */
const NOT_A_PAGE = /\.(avif|bmp|css|csv|docx?|gif|gz|ico|jpe?g|js|json|mjs|mp3|mp4|pdf|png|pptx?|rar|svg|tar|txt|webm|webp|woff2?|xlsx?|xml|zip)$/i;

/** Runs `worker` over `items` with at most `limit` running at a time, keeping the results in order. */
async function inParallel<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

/** Resource URLs named in a page's HTML, in document order, without duplicates. */
function resourceUrls(root: ReturnType<typeof parseHtml>, base: URL): string[] {
  const found = new Set<string>();
  const push = (href: string | null) => {
    if (!href) return;
    try {
      const resolved = new URL(href);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") found.add(resolved.href);
    } catch {
      /* not a URL */
    }
  };
  const srcset = (value: string | undefined) => {
    for (const part of (value ?? "").split(",")) push(abs(base, part.trim().split(/\s+/)[0]));
  };
  for (const img of root.querySelectorAll("img")) {
    push(abs(base, img.getAttribute("src")));
    srcset(img.getAttribute("srcset"));
  }
  for (const source of root.querySelectorAll("source")) {
    push(abs(base, source.getAttribute("src")));
    srcset(source.getAttribute("srcset"));
  }
  for (const link of root.querySelectorAll("link")) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase();
    if (rel.includes("stylesheet") || rel.includes("preload") || rel.includes("icon")) push(abs(base, link.getAttribute("href")));
  }
  for (const script of root.querySelectorAll("script[src]")) push(abs(base, script.getAttribute("src")));
  return [...found];
}

/**
 * Links on a page that lead to another page of the same origin, in document
 * order, without duplicates. Only these are ever followed: the audit never
 * leaves the origin it was pointed at.
 */
function sameOriginPages(root: ReturnType<typeof parseHtml>, base: URL): URL[] {
  const self = `${base.pathname}${base.search}`;
  const seen = new Set<string>([self]);
  const pages: URL[] = [];
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = abs(base, anchor.getAttribute("href"));
    if (!href) continue;
    let target: URL;
    try {
      target = new URL(href);
    } catch {
      continue;
    }
    if (target.origin !== base.origin || (target.protocol !== "http:" && target.protocol !== "https:")) continue;
    target.hash = "";
    const key = `${target.pathname}${target.search}`;
    if (seen.has(key) || NOT_A_PAGE.test(target.pathname)) continue;
    seen.add(key);
    pages.push(target);
  }
  return pages;
}

/**
 * Inspects a public page, and optionally further pages of the same origin
 * that it links to.
 *
 * It reads the initial HTML of each page and the resources that HTML names.
 * It does not run JavaScript and does not crawl: at most the configured
 * number of pages, one link away from the requested page, on its origin only.
 * Everything is bounded: resources per page, bytes per document and per
 * resource, bytes in total, requests in flight, and time.
 */
export async function runWebsiteAudit(rawUrl: string, options: AuditOptions = {}): Promise<AuditReport> {
  const started = Date.now();
  const deadline = started + limits.auditTotalTimeoutMs;
  const fetcher = options.fetcher ?? fetchPublic;
  let url: URL;
  try {
    url = await withinDeadline((options.validateUrl ?? validateAuditUrl)(rawUrl), deadline);
  } catch (error) {
    if (error instanceof Error && error.message === "AUDIT_TIMEOUT") {
      throw unprocessable("The website audit reached its overall time budget while resolving the page URL.", "Check the URL or retry later.");
    }
    throw error;
  }

  const pagesRequested = 1 + Math.max(0, Math.min(Math.floor(options.extraPages ?? 0), limits.auditMaxPages - 1));
  const psiReserveMs = process.env.PAGESPEED_API_KEY ? limits.auditPageSpeedTimeoutMs : 0;
  const timeLeft = (): number => deadline - Date.now() - psiReserveMs;
  const stoppedBy = new Set<string>();

  // The total byte budget. A request reserves the most it may read before it
  // starts and gives back what it did not use, so requests that run together
  // can never read more than the budget between them. When less than a full
  // allowance is free, a request waits for the others to finish and uses what
  // is then left, so the budget is used up to what the resources' sizes allow.
  let budgetLeft = limits.auditMaxTotalBytes;
  let inFlight = 0;
  const waiting: Array<() => void> = [];
  const withBudget = async <T extends { body: Buffer }>(cap: number, request: (maxBytes: number) => Promise<T>): Promise<T | "no_budget"> => {
    while (budgetLeft < cap && inFlight > 0) await new Promise<void>((resolve) => waiting.push(resolve));
    if (budgetLeft <= 0) return "no_budget";
    const allowance = Math.min(cap, budgetLeft);
    budgetLeft -= allowance;
    inFlight += 1;
    try {
      const result = await request(allowance);
      budgetLeft += allowance - result.body.byteLength;
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === "AUDIT_SIZE_LIMIT") {
        // The response was cut off at the allowance, so up to that much was read: it stays spent.
        // If the allowance was only what remained of the budget, the budget is what stopped it.
        if (allowance < cap) return "no_budget";
      } else {
        budgetLeft += allowance;
      }
      throw error;
    } finally {
      inFlight -= 1;
      for (const wake of waiting.splice(0)) wake();
    }
  };

  const pages: AuditPage[] = [];
  const resources: AuditResource[] = [];
  const findings: AuditFinding[] = [];
  const requested = new Set<string>();
  const skippedRow = (href: string, page: string, reason: string): AuditResource => ({
    url: href, page, kind: classify(href, null), origin: "document-html", status: null, contentType: null, transferredBytes: null, width: null, height: null, skipped: reason,
  });

  /** Requests one resource and measures it. Never throws: a failure becomes a row that says why. */
  const inspect = async (href: string, page: string): Promise<AuditResource> => {
    if (timeLeft() <= 150) {
      stoppedBy.add("time budget");
      return skippedRow(href, page, "overall audit time budget reached");
    }
    let parsed: URL;
    try {
      parsed = parseHttpUrl(href);
    } catch {
      return { ...skippedRow(href, page, "invalid URL"), kind: "other" };
    }
    try {
      const fetched = await withBudget(limits.auditMaxResourceBytes, (maxBytes) => fetcher(parsed, maxBytes, deadline, psiReserveMs));
      if (fetched === "no_budget") {
        stoppedBy.add("total byte budget");
        return skippedRow(href, page, "total byte budget of the audit reached");
      }
      const kind = classify(fetched.finalUrl, fetched.contentType);
      let width: number | null = null;
      let height: number | null = null;
      let finding: string | undefined;
      if (kind === "image") {
        // Dimensions come from the file's header. The image is never decoded:
        // bytes fetched from another site are not handed to an image decoder.
        const header = readImageHeader(fetched.body);
        if (header === null || header.malformed) {
          finding = "The image's header could not be read.";
        } else {
          ({ width, height } = displayedSize(header));
          if (fetched.body.byteLength > 300 * 1024) {
            finding = `Image is ${(fetched.body.byteLength / 1024).toFixed(0)} KB. Test a WebP/AVIF conversion in the Image Optimizer.`;
          }
        }
      }
      if (kind === "stylesheet") {
        const gaps = countFontDisplayGaps(fetched.body.toString("utf8"));
        if (gaps === null) finding = "Stylesheet could not be parsed.";
        else if (gaps.missing > 0) finding = `${gaps.missing} of ${gaps.total} @font-face rules lack font-display.`;
      }
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
      return { url: fetched.finalUrl, page, kind, origin: "document-html", status: fetched.status, contentType: fetched.contentType, transferredBytes: fetched.body.byteLength, width, height, finding };
    } catch (error) {
      return skippedRow(href, page, error instanceof Error ? error.message : "fetch failed");
    }
  };

  const queue: URL[] = [url];
  let entry: EntryDocument | null = null;
  let discoveredTotal = 0;

  while (queue.length > 0 && pages.length < pagesRequested) {
    const pageUrl = queue.shift() as URL;
    const first: boolean = entry === null;
    if (!first && timeLeft() <= 150) {
      stoppedBy.add("time budget");
      break;
    }

    let document: Fetched | "no_budget";
    try {
      document = await withBudget(limits.auditMaxHtmlBytes, (maxBytes) => fetcher(pageUrl, maxBytes, deadline, first ? 0 : psiReserveMs));
    } catch (error) {
      // The requested page failing is the audit failing. A further page failing is one row.
      if (first) throw error;
      resources.push({ ...skippedRow(pageUrl.href, pageUrl.href, error instanceof Error ? error.message : "fetch failed"), kind: "document" });
      continue;
    }
    if (document === "no_budget") {
      stoppedBy.add("total byte budget");
      break;
    }
    if (first && document.status >= 400) throw unprocessable(`The page returned HTTP ${document.status}.`);
    const finalUrl = new URL(document.finalUrl);
    if (!first && (document.status >= 400 || finalUrl.origin !== new URL((entry as EntryDocument).finalUrl).origin)) {
      resources.push({
        ...skippedRow(document.finalUrl, document.finalUrl, document.status >= 400 ? `HTTP ${document.status}` : "redirected to another origin"),
        kind: "document",
        status: document.status,
      });
      continue;
    }

    const root = parseHtml(document.body.toString("utf8"));
    const title = root.querySelector("title")?.text?.trim() || null;
    if (first) {
      entry = { finalUrl: document.finalUrl, status: document.status, contentType: document.contentType, bytes: document.body.byteLength, title };
      // Further pages come from this page only, and only as many as were asked for.
      queue.push(...sameOriginPages(root, finalUrl).slice(0, pagesRequested - 1));
    }

    // Relative URLs are resolved against the address the document was finally served from.
    const named = resourceUrls(root, finalUrl);
    discoveredTotal += named.length;
    if (named.length > limits.auditMaxResources) stoppedBy.add("resources-per-page limit");
    // A resource that an earlier page already named is not requested again.
    const fresh = named.slice(0, limits.auditMaxResources).filter((href) => !requested.has(href));
    for (const href of fresh) requested.add(href);

    resources.push({ url: document.finalUrl, page: document.finalUrl, kind: "document", origin: "document-html", status: document.status, contentType: document.contentType, transferredBytes: document.body.byteLength, width: null, height: null });
    resources.push(...(await inParallel(fresh, limits.auditConcurrency, (href) => inspect(href, document.finalUrl))));
    pages.push({ url: document.finalUrl, status: document.status, contentType: document.contentType, bytes: document.body.byteLength, title, resourcesFound: named.length, resourcesRequested: fresh.length });
  }

  if (entry === null) throw unprocessable("The page could not be read within the audit's limits.");
  const requestedEntry = entry as EntryDocument;
  const ok = resources.filter((r) => r.status && r.status < 400);
  const transferred = ok.reduce((sum, r) => sum + (r.transferredBytes ?? 0), 0);
  const psi = await pagespeed(requestedEntry.finalUrl, deadline - Date.now());
  const sum = (kind: AuditResource["kind"]): number => ok.filter((r) => r.kind === kind).reduce((total, r) => total + (r.transferredBytes ?? 0), 0);

  findings.unshift({
    id: "coverage",
    severity: "info",
    title: pages.length > 1 ? `This is a document-level lab fetch of ${pages.length} pages, not a browser session or a crawl.` : "This is a document-level lab fetch, not a browser session.",
    evidence: `HTML of ${pages.length} page${pages.length === 1 ? "" : "s"} parsed for ${discoveredTotal} discoverable URLs. JavaScript-inserted resources are not observed.`,
    action: "Treat Core Web Vitals as unavailable unless PageSpeed Insights is configured.",
    heuristic: false,
  });

  return {
    url: url.href,
    fetchedUrl: requestedEntry.finalUrl,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    coverage: {
      mode: pages.length > 1 ? "multi-document" : "single-document",
      javascriptRendered: false,
      note:
        pages.length > 1
          ? "Assets listed in the initial HTML of the requested page and of same-origin pages it links to. No headless Chrome, so client-rendered resources are out of scope, and no page beyond those listed was visited."
          : "Assets listed in the initial HTML and same-document srcset/src/href. No headless Chrome, so client-rendered resources are out of scope.",
      pagesRequested,
      pagesInspected: pages.length,
      limits: {
        maxPages: limits.auditMaxPages,
        maxResourcesPerPage: limits.auditMaxResources,
        maxDocumentBytes: limits.auditMaxHtmlBytes,
        maxResourceBytes: limits.auditMaxResourceBytes,
        maxTotalBytes: limits.auditMaxTotalBytes,
        timeBudgetMs: limits.auditTotalTimeoutMs,
        concurrency: limits.auditConcurrency,
      },
      stoppedBy: [...stoppedBy],
    },
    pages,
    document: { status: requestedEntry.status, contentType: requestedEntry.contentType, bytes: requestedEntry.bytes, title: requestedEntry.title },
    resources,
    totals: {
      requestsAttempted: resources.length,
      requestsOk: ok.length,
      transferredBytes: transferred,
      imageBytes: sum("image"),
      fontBytes: sum("font"),
      cssBytes: sum("stylesheet"),
      scriptBytes: sum("script"),
    },
    findings,
    pagespeed: psi,
  };
}
