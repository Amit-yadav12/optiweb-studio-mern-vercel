#!/usr/bin/env node
/**
 * Smoke test for a running site. It uses only public HTTP requests and needs
 * nothing but Node, so it can be pointed at production, a preview or a local
 * server.
 *
 *   node scripts/deployed-smoke.mjs <base-url> [--expect-build] [--wait <seconds>] [--audit <page-url>]
 *
 * It answers the questions a broken deployment raises:
 *
 *  - Is the site serving this build? With `--expect-build` the app script the
 *    page loads is compared with the one in the local `dist/` (run
 *    `npm run build` first). `--wait` keeps checking for that many seconds, for
 *    a deployment that is still in progress. A site left on an older
 *    deployment fails here, with the name of the script it serves.
 *  - Does a deep link such as /app/images load the app?
 *  - Are the files the image tool needs served, with the right types? The
 *    script follows the app's own references to the worker and the AVIF codec.
 *  - Is the security policy in force that stops the page from sending data to
 *    any other origin?
 *  - Is the API deployed, and is it the API of this version: one that accepts
 *    no file and stores nothing? A host's own "not found" page means the
 *    server function is missing.
 *  - Does the one server-side tool, the website audit, refuse private
 *    addresses, and (on a public address) can it read a page?
 *
 * With `--audit <page-url>` it also asks the site to audit that page, and
 * reports how many of the page's resources on other hosts the audit could
 * read. The site's own home page cannot show that: its files are all on one
 * host. This is an observation and never a failure: the page belongs to someone
 * else, and a test of this site must not fail because another site is slow,
 * down, or refuses the request.
 *
 * It sends one small generated image to prove that uploads are refused, and
 * asks for at most four audits. It changes nothing on the site.
 */
import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { isIP } from "node:net";
import { createChecker, solidPng } from "./lib/selftest-kit.mjs";

const args = process.argv.slice(2);
/** The word after a flag, or null when the flag is absent or last. */
const valueOf = (flag) => (args.includes(flag) ? (args[args.indexOf(flag) + 1] ?? null) : null);
const isAddress = (value) => /^https?:\/\/[^/\s]+/.test(value ?? "");
const auditPage = valueOf("--audit");
const base = (args.find((arg, index) => isAddress(arg) && args[index - 1] !== "--audit") ?? "").replace(/\/+$/, "");
const expectBuild = args.includes("--expect-build");
const waitSeconds = Number(valueOf("--wait")) || 0;

if (!base || (args.includes("--audit") && !isAddress(auditPage))) {
  console.error("Usage: node scripts/deployed-smoke.mjs <base-url> [--expect-build] [--wait <seconds>] [--audit <page-url>]");
  process.exit(2);
}

const TITLE = "deployed-smoke";
const { check, section, report, crashed } = createChecker(TITLE);
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

/** Writes a line to the log and, in GitHub Actions, a notice that can be read from the Checks API. */
function note(message) {
  console.log(`  · ${message}`);
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::notice title=${TITLE}::${message.replace(/%/g, "%25").replace(/\r?\n/g, " ")}`);
}

/** One request. Never throws: a network failure is reported as status 0. */
async function request(path, init = {}) {
  try {
    const response = await fetch(`${base}${path}`, { redirect: "follow", signal: AbortSignal.timeout(90_000), ...init });
    const bytes = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "";
    let json = null;
    if (type.includes("json")) {
      try { json = JSON.parse(bytes.toString("utf8")); } catch { json = null; }
    }
    return { status: response.status, type, bytes, json, headers: response.headers, text: /json|text|javascript/.test(type) ? bytes.toString("utf8") : "" };
  } catch (error) {
    return { status: 0, type: "", bytes: Buffer.alloc(0), json: null, headers: new Headers(), text: "", error: error instanceof Error ? error.name : "request failed" };
  }
}

/** What a response was, in a few words, for a failure message. */
const seen = (response) => (response.status === 0 ? `no response (${response.error})` : `HTTP ${response.status}, ${response.type || "no content type"}${response.json?.error?.code ? `, ${response.json.error.code}` : ""}`);
const kb = (bytes) => `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;

/* --------------------------------------------------------------- the build */
section(`${base}: the app`);
const ENTRY_SCRIPT = /\/assets\/index-[\w-]+\.js/;
let expected = null;
if (expectBuild) {
  const html = await fs.readFile(new URL("../dist/index.html", import.meta.url), "utf8").catch(() => null);
  expected = html ? ENTRY_SCRIPT.exec(html)?.[0] ?? null : null;
  check("a local build exists to compare the site with", expected !== null, "dist/index.html is missing; run npm run build first");
}

const deadline = Date.now() + waitSeconds * 1000;
let home = await request("/");
let served = ENTRY_SCRIPT.exec(home.text)?.[0] ?? null;
while (expected && served !== expected && Date.now() < deadline) {
  console.log(`  … the site serves ${served ?? "no app script"}; waiting for ${expected}`);
  await sleep(10_000);
  home = await request("/");
  served = ENTRY_SCRIPT.exec(home.text)?.[0] ?? null;
}
check("the home page loads the app", home.status === 200 && served !== null, seen(home));
if (expected) {
  check(
    "the site serves the app script of this build",
    served === expected,
    `expected ${expected}, the site serves ${served ?? "no app script"}. If the deployment of this commit has finished, another deployment is assigned to this address: promote the new one in the hosting dashboard.`,
  );
}
check("the page is Unikit Studio", /<title>Unikit Studio\b/.test(home.text), /<title>([^<]*)<\/title>/.exec(home.text)?.[1] ?? "no title");

const deepLink = await request("/app/images");
check("a deep link (/app/images) loads the same app", deepLink.status === 200 && served !== null && deepLink.text.includes(served), seen(deepLink));

const policy = home.headers.get("content-security-policy") ?? "";
const directive = (name) => new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`).exec(policy)?.[1]?.trim() ?? null;
check("the page is sent with a content security policy", policy.length > 0, "no Content-Security-Policy header: the host's header rules are not applied");
check("the policy lets the page connect to its own origin only, so no file can be sent anywhere else", directive("connect-src") === "'self'" && directive("default-src") === "'self'" && directive("form-action") === "'self'", policy.slice(0, 200));
check("the policy allows the image codec (WebAssembly) and no script from elsewhere", directive("script-src") === "'self' 'wasm-unsafe-eval'" && directive("object-src") === "'none'", directive("script-src") ?? "no script-src");
check("the page cannot be framed, and content types are not guessed", directive("frame-ancestors") === "'none'" && home.headers.get("x-content-type-options") === "nosniff");
check("the page sets no cookie", home.headers.get("set-cookie") === null && deepLink.headers.get("set-cookie") === null);

const missing = await request(`/assets/not-in-this-build-${Date.now().toString(36)}.js`);
check("a build file that does not exist is a 404, not the app's page", missing.status === 404 && !/html/.test(missing.type), seen(missing));

/* ------------------------------------------------------- the image tool's files */
section("the files the image tool loads");
{
  // Follow the app's own references: entry script, then its chunks, to the worker and the codec.
  const NAME = /[\w.-]+-[\w-]{8}\.(?:js|wasm)\b/g;
  const entry = served ? served.replace("/assets/", "") : "";
  const queue = entry ? [entry] : [];
  const scripts = new Map();
  const codecs = new Set();
  while (queue.length > 0 && scripts.size < 80) {
    const name = queue.shift();
    if (scripts.has(name)) continue;
    const response = await request(`/assets/${name}`);
    scripts.set(name, response);
    if (response.status !== 200) continue;
    for (const match of response.text.match(NAME) ?? []) {
      if (match.endsWith(".wasm")) codecs.add(match);
      else if (!scripts.has(match)) queue.push(match);
    }
  }
  const broken = [...scripts].filter(([, response]) => response.status !== 200 || !/javascript/.test(response.type)).map(([name, response]) => `${name}: ${seen(response)}`);
  check(`every script the app refers to is served as JavaScript (${scripts.size} files)`, scripts.size > 3 && broken.length === 0, broken.slice(0, 4).join("; "));
  const cached = scripts.get(entry)?.headers.get("cache-control") ?? "";
  check("build files are cached as immutable", /immutable/.test(cached) && /max-age=31536000/.test(cached), cached || "no Cache-Control");
  const worker = [...scripts.keys()].find((name) => /^worker-/.test(name));
  check("the image worker is one of them", Boolean(worker), [...scripts.keys()].join(" ").slice(0, 200));
  const avif = [...codecs].find((name) => /^avif_enc/.test(name));
  check("the app refers to its AVIF encoder", Boolean(avif), [...codecs].join(" "));
  for (const name of codecs) {
    const response = await request(`/assets/${name}`);
    const isWasm = response.bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    check(`${name} is served as application/wasm (${kb(response.bytes.length)})`, response.status === 200 && response.type.startsWith("application/wasm") && isWasm, seen(response));
  }
}

/* ----------------------------------------------------------------- the API */
section("the API");
const health = await request("/api/v1/health");
const data = health.json?.data;
const apiDeployed = check(
  "/api/v1/health answers with the API's JSON",
  health.status === 200 && health.json?.ok === true && typeof data === "object" && data !== null,
  `${seen(health)}. An answer that is not JSON comes from the host: the server function is not deployed.`,
);
check(
  "it is the API of this version: it accepts no file, stores nothing and sets no cookie",
  data?.acceptsFileUploads === false && data?.storesFiles === false && data?.usesCookies === false && data?.processing?.images === "browser",
  data ? `the answer has ${Object.keys(data).join(", ")}: an older version is deployed` : "no answer",
);
check("it reports no database and no storage", data !== undefined && data !== null && !("database" in data) && !("storage" in data));
check("the API sets no cookie", health.headers.get("set-cookie") === null);
if (apiDeployed) note(`${data.service ?? "service"} ${data.version ?? ""}; audit limits: ${data.audit?.maxPages ?? "?"} pages, ${data.audit?.maxResourcesPerPage ?? "?"} resources per page; PageSpeed ${data.audit?.pagespeedConfigured ? "configured" : "not configured"}`);
const unknown = await request("/api/v1/does-not-exist");
check("an unknown /api path is answered by the API, not by the host", unknown.status === 404 && unknown.json?.error?.code === "not_found", seen(unknown));
const removed = await request("/api/v1/history");
check("an endpoint of the earlier, storing version answers 410 Gone", removed.status === 410 && removed.json?.error?.code === "gone", seen(removed));

/* ----------------------------------------------------------------- uploads */
section("uploads are refused");
{
  const canary = `smoke-${Date.now().toString(36)}`;
  const form = () => {
    const body = new FormData();
    body.append("files", new Blob([solidPng(64, 48, [54, 92, 230])], { type: "image/png" }), `${canary}.png`);
    body.append("format", "webp");
    return body;
  };
  const old = await request("/api/v1/images/optimize", { method: "POST", body: form() });
  check("an image sent to the old upload endpoint is not accepted (410)", old.status === 410 && old.json?.error?.code === "gone", seen(old));
  const audits = await request("/api/v1/audits", { method: "POST", body: form() });
  check("an image sent to the audit endpoint is not accepted (415)", audits.status === 415 && audits.json?.error?.code === "unsupported_media_type", seen(audits));
  // A page address has no code behind it. This server refuses the request; a static host may refuse it or answer with the page. Either way nothing reads the body.
  const page = await request("/app/images", { method: "POST", body: form() });
  check("an image sent to a page address goes nowhere: it is refused, or answered with the page itself", (page.status >= 400 && page.status < 500) || (page.status === 200 && served !== null && page.text.includes(served)), seen(page));
  check("no refusal repeats the file's name", [old, audits, page].every((response) => !response.bytes.includes(canary)));
}

/* ------------------------------------------------------------------- audit */
section("the website audit");
{
  const audit = (url) => request("/api/v1/audits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, extraPages: 0 }) });
  const loopback = await audit("http://127.0.0.1/");
  check("it refuses to fetch a loopback address", loopback.status === 400 && loopback.json?.error?.code === "bad_request", seen(loopback));
  const metadata = await audit("http://169.254.169.254/latest/meta-data/");
  check("it refuses to fetch the cloud metadata address", metadata.status === 400 && metadata.json?.error?.code === "bad_request", seen(metadata));
  const host = new URL(base).hostname;
  const isLocal = host === "localhost" || isIP(host.replace(/^\[|\]$/g, "")) !== 0;
  if (isLocal) {
    note("this is a local address, which the audit rightly refuses to fetch; auditing a public page is checked on a deployed site only");
  } else {
    const own = await audit(`${base}/`);
    const report = own.json?.data;
    check("it audits a public page: this site's own home page", own.status === 200 && report?.document?.status === 200 && Array.isArray(report?.resources) && report.resources.length > 0 && report.coverage?.javascriptRendered === false, `${seen(own)}${own.json?.error?.message ? `: ${own.json.error.message}` : ""}`);
    if (report) note(`audit of ${base}/: ${report.resources.length} resources, ${kb(report.totals?.transferredBytes ?? 0)} read, ${report.durationMs} ms`);
  }
  if (auditPage) {
    // An observation, not a check: see the note on --audit at the top.
    const other = await audit(auditPage);
    const found = other.json?.data;
    if (other.status !== 200 || !Array.isArray(found?.resources)) {
      note(`audit of ${auditPage}: the page was not read (${seen(other)}${other.json?.error?.message ? `: ${other.json.error.message}` : ""}), so nothing was learned about resources on other hosts`);
    } else {
      const hostOf = (address) => { try { return new URL(address).host; } catch { return ""; } };
      const pageHost = hostOf(found.fetchedUrl ?? auditPage);
      const resources = found.resources.filter((row) => row.kind !== "document");
      const elsewhere = resources.filter((row) => hostOf(row.url) !== pageHost);
      const read = elsewhere.filter((row) => row.skipped === undefined && typeof row.status === "number" && row.status < 400);
      const hosts = [...new Set(elsewhere.map((row) => hostOf(row.url)))];
      const reasons = [...new Set(elsewhere.filter((row) => !read.includes(row)).map((row) => row.skipped ?? `HTTP ${row.status}`))];
      note(
        `audit of ${auditPage}: the page and ${resources.length} resources, ${elsewhere.length} of them on ${hosts.length === 1 ? "another host" : `${hosts.length} other hosts`}` +
          `${hosts.length > 0 ? ` (${hosts.join(", ")})` : ""}; ${read.length} of those ${elsewhere.length} were read${reasons.length > 0 ? ` (the rest: ${reasons.join("; ")})` : ""}; ` +
          `${kb(found.totals?.transferredBytes ?? 0)} in ${found.durationMs} ms`,
      );
    }
  }
}

const ok = report();
if (ok) console.log(`\n${base} passed the smoke test.`);
process.exit(ok ? 0 : 1);
