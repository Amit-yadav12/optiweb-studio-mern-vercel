#!/usr/bin/env node
/**
 * Self-test of the website audit's crawl logic. Needs no network.
 *
 *   npm run test:audit
 *
 * The audit is given a made-up site through its network parameter, and the
 * test checks what it requested and what it reported: which pages it visits,
 * how many resources per page, that nothing is requested twice, and that the
 * limits on bytes, time and parallel requests hold.
 *
 * Image sizes in the report come from the same header parser the browser
 * uses (`src/shared/imageHeader.ts`): the server decodes no image either.
 *
 * The real network layer, which refuses private and reserved addresses and
 * re-checks every redirect, is not replaced in production and is not what
 * this test covers; `test:security` and `test:api` probe it.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { createChecker, fixture, solidPng } from "./lib/selftest-kit.mjs";

delete process.env.PAGESPEED_API_KEY;

const { check, section, report, crashed } = createChecker("audit-selftest");
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

const { runWebsiteAudit } = await import("../src/server/services/auditService.ts");
const { limits } = await import("../src/server/config/env.ts");
const MB = 1024 * 1024;
const defaults = { bytes: limits.auditMaxTotalBytes, time: limits.auditTotalTimeoutMs };
/** Runs `task` with a smaller byte or time budget, then restores the configured one. */
async function withBudgets({ bytes = defaults.bytes, time = defaults.time }, task) {
  limits.auditMaxTotalBytes = bytes;
  limits.auditTotalTimeoutMs = time;
  try {
    return await task();
  } finally {
    limits.auditMaxTotalBytes = defaults.bytes;
    limits.auditTotalTimeoutMs = defaults.time;
  }
}

const ORIGIN = "https://site.example";
const png = solidPng(20, 10, [1, 2, 3]);
const html = (title, body) => Buffer.from(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

/** A made-up site and a network layer that serves it, records every request and counts requests in flight. */
function fakeSite(routes, { delayMs = 0 } = {}) {
  const calls = [];
  let inFlight = 0;
  let peak = 0;
  const fetcher = async (url, maxBytes) => {
    calls.push({ url: url.href, maxBytes });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      if (delayMs > 0) await sleep(delayMs);
      const route = routes[url.href];
      if (!route) return { status: 404, contentType: "text/plain", body: Buffer.from("not found"), finalUrl: url.href };
      const body = route.body ?? Buffer.alloc(0);
      if (body.length > maxBytes) throw new Error("AUDIT_SIZE_LIMIT");
      return { status: route.status ?? 200, contentType: route.type ?? "text/html", body, finalUrl: route.finalUrl ?? url.href };
    } finally {
      inFlight -= 1;
    }
  };
  return { fetcher, calls, peak: () => peak, requested: () => calls.map((call) => call.url) };
}
const audit = (site, url, extraPages) => runWebsiteAudit(url, { extraPages, fetcher: site.fetcher, validateUrl: async (raw) => new URL(raw) });
const count = (list, value) => list.filter((entry) => entry === value).length;

/* ------------------------------------------------------------------ pages */
section("pages: the requested page, plus same-origin pages it links to, up to the limit");
const routes = {
  [`${ORIGIN}/`]: { body: html("Home", `
    <link rel="stylesheet" href="/shared.css"><img src="/home.png">
    <a href="/">self</a> <a href="#top">fragment</a> <a href="/a">A</a> <a href="/a#section">A again</a>
    <a href="https://other.example/x">elsewhere</a> <a href="/guide.pdf">a file</a> <a href="mailto:x@site.example">mail</a>
    <a href="/b?page=2">B</a> <a href="/c">C</a> <a href="/d">D</a>`) },
  [`${ORIGIN}/a`]: { body: html("A", '<link rel="stylesheet" href="/shared.css"><img src="/a.png"><script src="/app.js"></script>') },
  [`${ORIGIN}/b?page=2`]: { body: html("B", '<link rel="stylesheet" href="/shared.css"><img src="/b.png"><a href="/deep">deeper</a>') },
  [`${ORIGIN}/c`]: { body: html("C", '<img src="/c.png">') },
  [`${ORIGIN}/shared.css`]: { type: "text/css", body: Buffer.from("@font-face{font-family:x;src:url(x.woff2)}") },
  [`${ORIGIN}/home.png`]: { type: "image/png", body: png },
  [`${ORIGIN}/a.png`]: { type: "image/png", body: png },
  [`${ORIGIN}/b.png`]: { type: "image/png", body: png },
  [`${ORIGIN}/app.js`]: { type: "text/javascript", body: Buffer.from("console.log(1)") },
};
{
  const site = fakeSite(routes);
  const one = await audit(site, `${ORIGIN}/`, 0);
  check("with no extra pages, only the requested page is read", one.pages.length === 1 && one.coverage.mode === "single-document" && one.coverage.pagesRequested === 1 && !site.requested().some((url) => /\/(a|b\?page=2|c|d)$/.test(url)), site.requested().join(" "));
  check("its resources are measured: status, bytes, and image dimensions", one.resources.find((row) => row.url.endsWith("/home.png"))?.width === 20 && one.resources.find((row) => row.url.endsWith("/home.png")).transferredBytes === png.length && one.document.title === "Home");
}
{
  const site = fakeSite(routes);
  const three = await audit(site, `${ORIGIN}/`, 2);
  const visited = three.pages.map((page) => page.url);
  check("with two extra pages, the first two same-origin links are read, in document order", visited.join(" ") === `${ORIGIN}/ ${ORIGIN}/a ${ORIGIN}/b?page=2` && three.coverage.mode === "multi-document" && three.coverage.pagesInspected === 3, visited.join(" "));
  const requested = site.requested();
  check("the page limit holds: the third and fourth links are never requested", !requested.includes(`${ORIGIN}/c`) && !requested.includes(`${ORIGIN}/d`));
  check("links to another origin, to files, to mail and to the page itself are not followed", !requested.some((url) => url.startsWith("https://other.example")) && !requested.includes(`${ORIGIN}/guide.pdf`) && count(requested, `${ORIGIN}/`) === 1);
  check("a page reached through a link is not searched for further pages", !requested.includes(`${ORIGIN}/deep`));
  check("a stylesheet shared by all three pages is requested once", count(requested, `${ORIGIN}/shared.css`) === 1 && three.pages[1].resourcesFound === 3 && three.pages[1].resourcesRequested === 2, `${count(requested, `${ORIGIN}/shared.css`)} requests`);
  check("every resource row names the page it was found on", three.resources.find((row) => row.url.endsWith("/a.png"))?.page === `${ORIGIN}/a` && three.resources.find((row) => row.url.endsWith("/shared.css"))?.page === `${ORIGIN}/`);
  check("the report states its limits and that it is not a crawl or a browser session", three.coverage.javascriptRendered === false && three.coverage.limits.maxPages === 3 && three.coverage.limits.maxResourcesPerPage === 25 && three.coverage.limits.maxDocumentBytes === MB && three.coverage.limits.maxResourceBytes === MB && three.coverage.limits.maxTotalBytes === 24 * MB && three.coverage.limits.timeBudgetMs === 45_000 && three.coverage.limits.concurrency === 4 && /not a browser session or a crawl/.test(three.findings[0].title) && three.coverage.stoppedBy.length === 0, JSON.stringify(three.coverage.limits));
  check("findings are labelled as measured or heuristic, and field data is reported as unavailable", three.findings.every((finding) => typeof finding.heuristic === "boolean") && three.findings.some((finding) => /font-display/.test(finding.title) && finding.heuristic === false) && three.pagespeed.configured === false && three.pagespeed.lab === null && three.pagespeed.field === null);
  const many = await audit(fakeSite(routes), `${ORIGIN}/`, 9).catch((error) => error);
  check("a request for more pages than the limit is cut to the limit", !(many instanceof Error) && many.pages.length <= limits.auditMaxPages && many.coverage.pagesRequested === 3, many instanceof Error ? many.message : `${many.pages.length} pages`);
}
{
  const site = fakeSite({
    ...routes,
    [`${ORIGIN}/`]: { body: html("Home", '<a href="/moved">moved</a><a href="/gone">gone</a><img src="/home.png">') },
    [`${ORIGIN}/moved`]: { body: html("Elsewhere", '<img src="https://other.example/secret.png">'), finalUrl: "https://other.example/landing" },
  });
  const result = await audit(site, `${ORIGIN}/`, 2);
  const moved = result.resources.find((row) => row.url === "https://other.example/landing");
  const gone = result.resources.find((row) => row.url === `${ORIGIN}/gone`);
  check("a linked page that redirects to another origin is recorded and not inspected", moved?.skipped === "redirected to another origin" && result.pages.length === 1 && !site.requested().includes("https://other.example/secret.png"), JSON.stringify(moved));
  check("a linked page that answers 404 is one row; the audit goes on", gone?.skipped === "HTTP 404" && gone.status === 404 && result.totals.requestsOk >= 2, JSON.stringify(gone));
}

/* ----------------------------------------------------------------- limits */
section("limits: resources per page, bytes per resource, bytes in total, requests in flight, time");
{
  const images = Array.from({ length: 40 }, (_, index) => `/img-${index}.png`);
  const site = fakeSite({
    [`${ORIGIN}/`]: { body: html("Many", images.map((src) => `<img src="${src}">`).join("")) },
    ...Object.fromEntries(images.map((src) => [`${ORIGIN}${src}`, { type: "image/png", body: png }])),
  }, { delayMs: 15 });
  const result = await audit(site, `${ORIGIN}/`, 0);
  check("of 40 resources on a page, 25 are requested, and the report says the limit was reached", result.pages[0].resourcesFound === 40 && result.pages[0].resourcesRequested === 25 && site.calls.length === 26 && result.coverage.stoppedBy.includes("resources-per-page limit"), `${site.calls.length} requests`);
  check("resources are requested in parallel, never more than 4 at a time", site.peak() === 4, `peak ${site.peak()}`);
  check("the rows keep document order", result.resources.slice(1).map((row) => row.url).join() === images.slice(0, 25).map((src) => `${ORIGIN}${src}`).join());
}
{
  const big = Buffer.alloc(600 * 1024, 1);
  const files = Array.from({ length: 8 }, (_, index) => `/big-${index}.bin`);
  const site = fakeSite({
    [`${ORIGIN}/`]: { body: html("Heavy", `<link rel="preload" href="/huge.bin">${files.map((src) => `<link rel="preload" href="${src}">`).join("")}`) },
    [`${ORIGIN}/huge.bin`]: { type: "application/octet-stream", body: Buffer.alloc(1024 * 1024 + 1, 1) },
    ...Object.fromEntries(files.map((src) => [`${ORIGIN}${src}`, { type: "application/octet-stream", body: big }])),
  }, { delayMs: 5 });
  // A 3 MB budget: the oversized file spends 1 MB of it, and three of the eight 600 KB files fit in the rest.
  const result = await withBudgets({ bytes: 3 * MB }, () => audit(site, `${ORIGIN}/`, 0));
  const huge = result.resources.find((row) => row.url.endsWith("/huge.bin"));
  const skipped = result.resources.filter((row) => row.skipped === "total byte budget of the audit reached");
  check("a resource above the per-resource limit is not read", huge?.skipped === "AUDIT_SIZE_LIMIT" && huge.transferredBytes === null, JSON.stringify(huge));
  const read = result.resources.filter((row) => row.url.includes("/big-") && row.status === 200).length;
  check("the audit never reads more than its total byte budget, and uses it as far as the files allow", result.totals.transferredBytes <= 3 * MB - (MB + 1) + 1 && read === 3, `${read} files, ${result.totals.transferredBytes} bytes`);
  check("what did not fit is listed as skipped, with the reason, and the report says which limit stopped it", skipped.length === 5 && result.coverage.stoppedBy.includes("total byte budget"), `${skipped.length} skipped; ${result.coverage.stoppedBy.join(", ")}`);
  check("no request was allowed more bytes than the budget still held", site.calls.every((call) => call.maxBytes <= limits.auditMaxResourceBytes) && site.calls.some((call) => call.maxBytes < 600 * 1024), site.calls.map((call) => call.maxBytes).join(" "));
}
{
  const slow = Array.from({ length: 25 }, (_, index) => `/slow-${index}.png`);
  const site = fakeSite({
    [`${ORIGIN}/`]: { body: html("Slow", slow.map((src) => `<img src="${src}">`).join("") + '<a href="/next">next</a>') },
    [`${ORIGIN}/next`]: { body: html("Next", "") },
    ...Object.fromEntries(slow.map((src) => [`${ORIGIN}${src}`, { type: "image/png", body: png }])),
  }, { delayMs: 300 });
  const started = Date.now();
  // Four at a time, 300 ms each, 1.5 s in total: about twenty of the twenty-five can be measured.
  const result = await withBudgets({ time: 1_500 }, () => audit(site, `${ORIGIN}/`, 1));
  const elapsed = Date.now() - started;
  const timedOut = result.resources.filter((row) => row.skipped === "overall audit time budget reached");
  check("the time budget ends the audit: remaining resources are listed as skipped, not waited for", elapsed < 2_500 && timedOut.length > 0 && result.coverage.stoppedBy.includes("time budget"), `${elapsed} ms, ${timedOut.length} skipped`);
  check("no further page is started once the time is used up", result.pages.length === 1 && !site.requested().includes(`${ORIGIN}/next`));
}
{
  const failure = await audit(fakeSite({ [`${ORIGIN}/`]: { status: 503, body: Buffer.from("down") } }), `${ORIGIN}/`, 2).then(() => null, (error) => error);
  check("the requested page failing fails the audit, with the status in the message", failure?.message === "The page returned HTTP 503." && failure.status === 422, String(failure?.message));
}

/* ---------------------------------------------------------- image facts */
section("images: sizes and traits are read from file headers, without decoding");
{
  const rotated = fixture("rotated-gps-240x160.jpg");
  const animated = fixture("animated-3f-60x40.gif");
  const site = fakeSite({
    [`${ORIGIN}/`]: { body: html("Images", '<img src="/rotated.jpg"><img src="/anim.gif"><img src="/fake.png"><img src="/cut.png">') },
    [`${ORIGIN}/rotated.jpg`]: { type: "image/jpeg", body: rotated },
    [`${ORIGIN}/anim.gif`]: { type: "image/gif", body: animated },
    [`${ORIGIN}/fake.png`]: { type: "image/png", body: Buffer.from("<html>this is not a PNG</html>") },
    [`${ORIGIN}/cut.png`]: { type: "image/png", body: png.subarray(0, 12) },
  });
  const result = await audit(site, `${ORIGIN}/`, 0);
  const row = (suffix) => result.resources.find((entry) => entry.url.endsWith(suffix));
  check("a rotated JPEG is reported with the size it is displayed at", row("/rotated.jpg")?.width === 160 && row("/rotated.jpg")?.height === 240, JSON.stringify(row("/rotated.jpg")));
  check("a GIF's size comes from its header", row("/anim.gif")?.width === 60 && row("/anim.gif")?.height === 40, JSON.stringify(row("/anim.gif")));
  check("a response that is not an image, or is cut off, has no size and does not fail the audit", row("/fake.png")?.width == null && row("/cut.png")?.width == null && row("/fake.png")?.status === 200, JSON.stringify([row("/fake.png"), row("/cut.png")]));
}

const ok = report();
if (ok) console.log("\nAll audit checks passed.");
process.exit(ok ? 0 : 1);
