/**
 * Server configuration.
 *
 * The server does one job that a browser cannot do: it fetches a public web
 * page for the website audit. It receives no files and stores nothing, so the
 * only limits here are the ones that keep an audit small and short.
 */

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** A positive number from the environment, never above `ceiling`. */
function capped(value: string | undefined, fallback: number, ceiling: number): number {
  return Math.min(num(value, fallback), ceiling);
}

/** `UNIKIT_<NAME>`, or the same setting under the prefix used before the rename. */
function setting(name: string): string | undefined {
  return process.env[`UNIKIT_${name}`] ?? process.env[`OW_${name}`];
}

const MB = 1024 * 1024;

export const APP_NAME = "Unikit Studio";
export const APP_TAGLINE = "Web-asset tools that run in your browser.";
export const APP_VERSION = "2.0.0";

/** Largest JSON body the API reads. The only body it accepts is an audit request: a URL and a page count. */
export const MAX_JSON_BODY_BYTES = 16 * 1024;

export const limits = {
  /** Website audit: largest page document that is read. */
  auditMaxHtmlBytes: Math.floor(capped(setting("AUDIT_MAX_HTML_MB"), 1, 1) * MB),
  /** Website audit: largest discovered resource that is read. */
  auditMaxResourceBytes: Math.floor(capped(setting("AUDIT_MAX_RESOURCE_MB"), 1, 1) * MB),
  /** Website audit: resources fetched per page, after its document. */
  auditMaxResources: Math.floor(capped(setting("AUDIT_MAX_RESOURCES"), 25, 25)),
  /** Website audit: pages per audit, the requested one included. Further pages are same-origin links found on it. */
  auditMaxPages: Math.floor(capped(setting("AUDIT_MAX_PAGES"), 3, 3)),
  /** Website audit: bytes one audit may read from the network in total, over all pages and resources. */
  auditMaxTotalBytes: Math.floor(capped(setting("AUDIT_MAX_TOTAL_MB"), 24, 48) * MB),
  /** Website audit: requests in flight at a time. */
  auditConcurrency: 4,
  /** Website audit: per-request timeout. */
  auditTimeoutMs: Math.min(num(setting("AUDIT_TIMEOUT_MS"), 4_000), 8_000),
  /** Website audit: time budget of one whole audit. */
  auditTotalTimeoutMs: Math.min(num(setting("AUDIT_TOTAL_TIMEOUT_MS"), 45_000), 120_000),
  /** Website audit: maximum time reserved for optional PageSpeed Insights. */
  auditPageSpeedTimeoutMs: Math.min(num(setting("AUDIT_PAGESPEED_TIMEOUT_MS"), 10_000), 12_000),
} as const;

export type RateLimitBucket = keyof typeof rateLimits;

/** Requests per client address in a time window. Counted in the memory of one server instance. */
export const rateLimits = {
  audits: { capacity: 10, windowMs: 60_000 },
} as const;

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
