#!/usr/bin/env node
/**
 * Self-test of the server's HTTP contract. Starts the real Express app in
 * this process; needs `npm run build` first, because the app serves `dist/`.
 *
 *   npm run test:api
 *
 * The server has one job, the website audit, and serves the built app. This
 * test checks what it answers, and above all what it refuses:
 *
 *  - no route accepts a file: every upload attempt is refused, on every path;
 *  - the endpoints of earlier versions answer 410 Gone;
 *  - no response sets a cookie;
 *  - every response carries the security headers, including the
 *    Content-Security-Policy that keeps the pages from sending data elsewhere;
 *  - the audit endpoint validates its input, refuses private addresses before
 *    any connection is made, and is rate limited;
 *  - nothing a client sends is written to the log.
 *
 * A complete audit of a public page needs the internet, so it is not run
 * here. `npm run test:audit` covers the audit itself against a made-up site.
 */
import http from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createChecker, fixture, startApi, UUID } from "./lib/selftest-kit.mjs";

delete process.env.PAGESPEED_API_KEY;

const { check, section, report, crashed } = createChecker("api-selftest");
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

const appDir = fileURLToPath(new URL("..", import.meta.url));
process.chdir(appDir);
if (!existsSync("dist/index.html")) {
  console.error("dist/index.html is missing. Run `npm run build` first: the server serves the built app.");
  process.exit(2);
}

const api = await startApi();
const { SECURITY_HEADERS, CONTENT_SECURITY_POLICY } = await import("../src/server/config/securityHeaders.ts");

/** Every response of the run, to check afterwards what all of them have in common. */
const seen = [];
let client = 0;
/** One request. Each call site may name its own client address, so rate limits of one section do not reach another. */
async function call(path, { ip = "198.51.100.1", headers = {}, ...init } = {}) {
  const response = await api.call(path, { ...init, headers: { "x-forwarded-for": ip, ...headers } });
  seen.push({ path, method: init.method ?? "GET", response });
  return response;
}
const nextClient = () => `198.51.100.${(client += 1) + 10}`;
const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const errorCode = (response) => response.json?.error?.code ?? null;

/* ------------------------------------------------------------------ health */
section("health: what this deployment is");
{
  const plain = await call("/api/health");
  check("GET /api/health answers 200 with JSON", plain.status === 200 && plain.json?.ok === true);
  check("it names the service and the version", plain.json.service === "Unikit Studio" && plain.json.version === "2.0.0", JSON.stringify(plain.json).slice(0, 200));
  check("it states where each tool runs: images, stylesheets and assets in the browser, the audit on the server", JSON.stringify(plain.json.processing) === JSON.stringify({ images: "browser", stylesheets: "browser", assets: "browser", audit: "server" }));
  check("it states that the server accepts no uploads, stores no files and uses no cookies", plain.json.acceptsFileUploads === false && plain.json.storesFiles === false && plain.json.usesCookies === false);
  check("it reports nothing about a database or object storage, because there is none", !/mongo|database|blob|storage|bucket|redis/i.test(JSON.stringify(plain.json).replace(/storesFiles/g, "")), JSON.stringify(plain.json));
  check("the audit limits are reported", plain.json.audit.maxPages === 3 && plain.json.audit.maxResourcesPerPage === 25 && plain.json.audit.pagespeedConfigured === false);
  const enveloped = await call("/api/v1/health");
  check("GET /api/v1/health wraps the same facts in the API envelope", enveloped.status === 200 && enveloped.json.ok === true && enveloped.json.data.service === "Unikit Studio" && enveloped.json.data.acceptsFileUploads === false);
  check("every answer has a request ID, in the header and in the body", UUID.test(enveloped.headers.get("x-request-id") ?? "") && enveloped.json.meta.requestId === enveloped.headers.get("x-request-id"));
  const supplied = await call("/api/v1/health", { headers: { "x-request-id": "trace-2025.abc_123" } });
  check("a well-formed request ID from the client is kept", supplied.json.meta.requestId === "trace-2025.abc_123");
  const hostile = await call("/api/v1/health", { headers: { "x-request-id": "<script>alert(1)</script>" } });
  check("a request ID that is not plain is replaced, not echoed", UUID.test(hostile.json.meta.requestId) && !hostile.visible.includes("<script>"));
  check("API answers are never cached", plain.headers.get("cache-control") === "no-store" && enveloped.headers.get("cache-control") === "no-store");
  const post = await call("/api/health", { method: "POST" });
  check("another method is refused with 405 and the allowed method", post.status === 405 && post.headers.get("allow") === "GET" && errorCode(post) === "method_not_allowed");
}

/* ----------------------------------------------------------------- uploads */
section("uploads: no route accepts a file");
const canary = `CANARY-${Date.now().toString(36)}`;
{
  const form = () => {
    const data = new FormData();
    data.append("files", new Blob([fixture("photo-800x600.jpg")], { type: "image/jpeg" }), `${canary}.jpg`);
    data.append("format", "webp");
    return data;
  };
  const attempts = [
    ["POST", "/api/v1/images/optimize", 410],
    ["POST", "/api/v1/assets/analyze", 410],
    ["POST", "/api/v1/uploads", 410],
    ["PUT", "/api/v1/uploads/abc/parts/1", 410],
    ["POST", "/api/v1/audits", 415],
    ["POST", "/api/v1/anything-else", 404],
    ["POST", "/api/upload", 404],
    ["POST", "/upload", 405],
    ["PUT", "/app/images", 405],
    ["POST", "/", 405],
  ];
  api.takeLogs();
  for (const [method, path, expected] of attempts) {
    const response = await call(path, { method, body: form() });
    check(`${method} ${path} with a multipart image is refused: ${expected}`, response.status === expected && response.json?.ok === false && !response.visible.includes(canary), `${response.status} ${errorCode(response)}`);
  }
  const raw = await call("/api/v1/audits", { method: "POST", headers: { "content-type": "image/jpeg" }, body: fixture("photo-800x600.jpg") });
  check("raw image bytes sent to the only POST endpoint are refused with 415, before the body is parsed", raw.status === 415 && errorCode(raw) === "unsupported_media_type" && /Files are not accepted by any endpoint/.test(raw.json.error.hint ?? ""), JSON.stringify(raw.json));
  const octets = await call("/api/v1/audits", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.alloc(4096, 7) });
  const noType = await call("/api/v1/audits", { method: "POST", body: "url=https://example.com" });
  check("so are a binary body and a body without a JSON content type", octets.status === 415 && noType.status === 415);
  const smuggled = await call("/api/v1/audits", json({ url: "https://example.com", file: fixture("flat-600x400.png").toString("base64"), filename: `${canary}.png` }));
  check("a file smuggled into the JSON as base64 is not returned in any form", !smuggled.visible.includes(canary) && !smuggled.visible.includes(fixture("flat-600x400.png").toString("base64").slice(0, 40)), `${smuggled.status}`);
  const big = await call("/api/v1/audits", json({ url: "https://example.com", padding: "x".repeat(20_000) }));
  check("a JSON body above 16 KB is refused with 413: there is no room for a file in it", big.status === 413 && errorCode(big) === "payload_too_large", `${big.status} ${errorCode(big)}`);
  check("nothing of the uploads was logged: no file name, no path of the request", !api.takeLogs().text.includes(canary));
}

/* --------------------------------------------------------- removed endpoints */
section("endpoints of earlier versions answer 410 Gone");
{
  const removed = [
    ["POST", "/api/v1/images/optimize"], ["GET", "/api/v1/images/jobs/abc"], ["POST", "/api/v1/assets/analyze"], ["POST", "/api/v1/css/analyze"], ["POST", "/api/v1/css/patch-font-display"],
    ["POST", "/api/v1/uploads"], ["GET", "/api/v1/jobs/abc"], ["GET", "/api/v1/artifacts/abc"], ["POST", "/api/v1/artifacts/zip"], ["GET", "/api/v1/history"], ["DELETE", "/api/v1/history/abc"],
    ["GET", "/api/v1/usage"], ["GET", "/api/v1/preferences"], ["PUT", "/api/v1/preferences"], ["GET", "/api/v1/session"], ["GET", "/api/v1/limits"], ["GET", "/api/v1/internal/cleanup"],
  ];
  const wrong = [];
  for (const [method, path] of removed) {
    const response = await call(path, { method });
    if (response.status !== 410 || errorCode(response) !== "gone" || !/in the browser/.test(response.json.error.hint ?? "")) wrong.push(`${method} ${path} → ${response.status} ${errorCode(response)}`);
  }
  check(`all ${removed.length} removed endpoints answer 410 with an explanation`, wrong.length === 0, wrong.join("; "));
  const history = await call("/api/v1/history", { headers: { cookie: "ow_sid=0123456789abcdef0123456789abcdef" } });
  check("a session cookie of the earlier version is ignored: nothing is looked up, and no cookie is set", history.status === 410 && history.headers.get("set-cookie") === null);
  const cron = await call("/api/v1/internal/cleanup", { headers: { authorization: "Bearer anything" } });
  check("the cleanup job's endpoint is gone too: there is nothing to clean up", cron.status === 410);
  const unknown = await call("/api/v1/does-not-exist");
  check("an API path that never existed answers 404 as JSON, not a page", unknown.status === 404 && errorCode(unknown) === "not_found" && unknown.json.meta.requestId.length > 0);
}

/* ------------------------------------------------------------------ audits */
section("website audit: input is validated, and private addresses are refused before any connection");
{
  const ip = nextClient();
  const get = await call("/api/v1/audits", { ip });
  check("GET is refused with 405 and the allowed method", get.status === 405 && get.headers.get("allow") === "POST");
  const broken = await call("/api/v1/audits", { ip, ...json('{"url": "https://example.com"') });
  check("malformed JSON is a 400 with a JSON answer, not a stack trace", broken.status === 400 && errorCode(broken) === "bad_request" && !/at .*\.(ts|js):\d+/.test(broken.text), broken.text.slice(0, 200));
  const empty = await call("/api/v1/audits", { ip, ...json({}) });
  check("a body without a URL is a 422 that names the field", empty.status === 422 && errorCode(empty) === "validation_error" && empty.json.error.details.some((detail) => detail.path === "url"), JSON.stringify(empty.json.error));
  const pages = await call("/api/v1/audits", { ip, ...json({ url: "https://example.com", extraPages: 50 }) });
  const typed = await call("/api/v1/audits", { ip, ...json({ url: ["https://example.com"] }) });
  check("a page count outside 0–2 and a URL that is not a string are refused", pages.status === 422 && typed.status === 422 && pages.json.error.details.some((detail) => detail.path === "extraPages"));
  const array = await call("/api/v1/audits", { ip, ...json("[1,2,3]") });
  const scalar = await call("/api/v1/audits", { ip, ...json('"https://example.com"') });
  check("a JSON array is a 422 and a bare string a 400: neither is read as a request", array.status === 422 && errorCode(array) === "validation_error" && scalar.status === 400 && errorCode(scalar) === "bad_request", `${array.status} ${scalar.status}`);
}
{
  // A server on this machine that records every connection. If the audit ever reached it, the guard would have failed.
  const hits = [];
  const trap = http.createServer((request, response) => {
    hits.push(request.url);
    response.end("<html><title>internal</title></html>");
  });
  trap.listen(0, "127.0.0.1");
  await once(trap, "listening");
  const port = trap.address().port;
  const targets = [
    `http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://127.1:${port}/`, `http://2130706433:${port}/`, `http://0x7f000001:${port}/`, `http://0177.0.0.1:${port}/`,
    `http://[::1]:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`, `http://[::ffff:7f00:1]:${port}/`, `http://[0:0:0:0:0:0:0:1]:${port}/`, `http://0.0.0.0:${port}/`,
    "http://169.254.169.254/latest/meta-data/", "http://metadata.google.internal/computeMetadata/v1/", "http://10.0.0.1/", "http://172.16.5.4/", "http://192.168.1.1/", "http://100.64.0.1/",
    "http://[fe80::1]/", "http://[fd00::1]/", "http://[64:ff9b::7f00:1]/", "http://service.internal/", "http://app.localhost/",
  ];
  const leaked = [];
  api.takeLogs();
  for (const target of targets) {
    const response = await call("/api/v1/audits", { ip: nextClient(), ...json({ url: `${target}?token=${canary}` }) });
    if (response.status !== 400 || errorCode(response) !== "bad_request" || response.visible.includes("internal</title>")) leaked.push(`${target} → ${response.status} ${errorCode(response)}`);
  }
  check(`${targets.length} ways of writing a loopback, private, link-local or metadata address are all refused with 400`, leaked.length === 0, leaked.join("; "));
  check("the server on this machine was never contacted", hits.length === 0, hits.join(" "));
  const schemes = [];
  for (const url of ["file:///etc/passwd", "ftp://example.com/file", "gopher://example.com/", "javascript:alert(1)//", "data:text/html,<p>x</p>", "https://user:secret@example.com/"]) {
    const response = await call("/api/v1/audits", { ip: nextClient(), ...json({ url }) });
    if (response.status !== 400) schemes.push(`${url} → ${response.status}`);
  }
  check("only http and https URLs without embedded credentials are accepted", schemes.length === 0, schemes.join("; "));
  check("an audited URL is never written to the log, even when it is refused", !api.takeLogs().text.includes(canary));
  trap.closeAllConnections?.();
  await new Promise((resolve) => trap.close(resolve));
}
{
  const ip = nextClient();
  const statuses = [];
  let last = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    last = await call("/api/v1/audits", { ip, ...json({}) });
    statuses.push(last.status);
  }
  check("one client gets ten audit requests a minute; the eleventh is refused with 429", statuses.slice(0, 10).every((status) => status === 422) && statuses[10] === 429 && statuses[11] === 429, statuses.join(" "));
  check("the 429 says when to try again, in the header and in the body", Number(last.headers.get("retry-after")) > 0 && Number(last.headers.get("retry-after")) <= 60 && last.json.error.details.retryAfterSeconds === Number(last.headers.get("retry-after")) && errorCode(last) === "rate_limited");
  const other = await call("/api/v1/audits", { ip: nextClient(), ...json({}) });
  check("another client is not affected", other.status === 422);
  const unlimited = await call("/api/v1/health", { ip });
  check("the limit applies to audits only: the limited client can still read the health endpoint", unlimited.status === 200);
}

/* ------------------------------------------------------------------ static */
section("the built app: pages, files and caching");
{
  const home = await call("/");
  check("GET / serves the app", home.status === 200 && /text\/html/.test(home.headers.get("content-type") ?? "") && home.text.includes('<div id="root">') && home.text.includes("Unikit Studio"));
  check("the page is revalidated on every visit, so a new deployment is picked up", home.headers.get("cache-control") === "no-cache");
  const deep = await call("/app/images");
  const retired = await call("/app/history/123");
  check("a deep link serves the same app, which then routes in the browser", deep.status === 200 && deep.text === home.text && retired.text === home.text);
  const assets = readdirSync("dist/assets");
  const script = assets.find((name) => /^index-.*\.js$/.test(name));
  const wasm = assets.find((name) => /^avif_enc.*\.wasm$/.test(name));
  const worker = assets.find((name) => /^worker-.*\.js$/.test(name));
  const js = await call(`/assets/${script}`);
  check("the hashed app script is served as JavaScript and cached for a year", js.status === 200 && /javascript/.test(js.headers.get("content-type") ?? "") && js.headers.get("cache-control") === "public, max-age=31536000, immutable", `${js.status} ${js.headers.get("cache-control")}`);
  check("the build contains the image worker and the AVIF codec as files of this site", Boolean(worker) && Boolean(wasm), assets.join(" ").slice(0, 300));
  const codec = await call(`/assets/${wasm}`);
  check("the codec is served as application/wasm, which a browser requires to compile it while it downloads", codec.status === 200 && codec.headers.get("content-type") === "application/wasm" && codec.bytes.subarray(0, 4).toString("latin1") === "\0asm", String(codec.headers.get("content-type")));
  const expected = { "/favicon.svg": /svg/, "/site.webmanifest": /json/, "/robots.txt": /text\/plain/, "/theme.js": /javascript/, "/og-image.png": /image\/png/, "/icons/icon-192.png": /image\/png/, "/icons/apple-touch-icon.png": /image\/png/ };
  const missing = [];
  for (const [path, type] of Object.entries(expected)) {
    const response = await call(path);
    if (response.status !== 200 || !type.test(response.headers.get("content-type") ?? "") || response.bytes.length === 0) missing.push(`${path} → ${response.status} ${response.headers.get("content-type")}`);
  }
  check("the favicon, manifest, robots file, theme script, social image and icons are served with their types", missing.length === 0, missing.join("; "));
  const manifest = await call("/site.webmanifest");
  check("the manifest names the product", JSON.parse(manifest.bytes.toString("utf8")).name === "Unikit Studio");
  const missingAsset = await call("/assets/does-not-exist.js");
  check("a file under /assets that does not exist is a 404, never the app's page in place of a script", missingAsset.status === 404 && !/html|javascript/.test(missingAsset.headers.get("content-type") ?? ""), `${missingAsset.status} ${missingAsset.headers.get("content-type")}`);
  const escapes = [];
  for (const path of ["/..%2f..%2fpackage.json", "/assets/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json", "/assets/%2e%2e/%2e%2e/src/app.ts", "/..%5c..%5cpackage.json", "/.env", "/.git/config", "/assets/../../.env.example"]) {
    const response = await call(path);
    if (/"name": "unikit-studio"|import express|PAGESPEED_API_KEY=|\[core\]/.test(response.bytes.toString("utf8"))) escapes.push(`${path} → ${response.status}`);
  }
  check("no path reaches a file outside the build: not the source, not package.json, not a dotfile", escapes.length === 0, escapes.join("; "));
  const head = await call("/", { method: "HEAD" });
  check("HEAD works for pages", head.status === 200 && head.bytes.length === 0);
}

/* --------------------------------------------------------------- everywhere */
section(`every response of this run (${seen.length} of them)`);
{
  const cookies = seen.filter(({ response }) => response.headers.get("set-cookie") !== null).map(({ method, path }) => `${method} ${path}`);
  check("none sets a cookie", cookies.length === 0, cookies.join("; "));
  const unprotected = [];
  for (const { method, path, response } of seen) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (response.headers.get(name) !== value) unprotected.push(`${method} ${path}: ${name}`);
    }
  }
  check("all carry the security headers, errors included", unprotected.length === 0, unprotected.slice(0, 6).join("; "));
  check("the policy lets pages talk to their own origin only, allows no inline script and no eval", /connect-src 'self'(;|$)/.test(CONTENT_SECURITY_POLICY) && /form-action 'self'/.test(CONTENT_SECURITY_POLICY) && /script-src 'self' 'wasm-unsafe-eval'(;|$)/.test(CONTENT_SECURITY_POLICY) && !/script-src[^;]*'unsafe-(inline|eval)'/.test(CONTENT_SECURITY_POLICY) && /object-src 'none'/.test(CONTENT_SECURITY_POLICY) && /frame-ancestors 'none'/.test(CONTENT_SECURITY_POLICY));
  check("none reveals the server software", seen.every(({ response }) => response.headers.get("x-powered-by") === null));
  const errors = seen.filter(({ response }) => response.status >= 400 && response.status !== 404 || (response.status === 404 && response.json));
  const malformed = errors.filter(({ response }) => !(response.json?.ok === false && typeof response.json.error?.code === "string" && typeof response.json.error.message === "string" && typeof response.json.meta?.requestId === "string"));
  check(`all ${errors.length} error answers are JSON in one shape: ok, error.code, error.message, meta.requestId`, malformed.length === 0, malformed.slice(0, 4).map(({ method, path, response }) => `${method} ${path} ${response.status}`).join("; "));
  const traces = seen.filter(({ response }) => /\bat \S+ \(.*:\d+:\d+\)|node_modules|\/home\/|[A-Z]:\\\\/.test(response.text)).map(({ method, path }) => `${method} ${path}`);
  check("no answer contains a stack trace or a path of the server's file system", traces.length === 0, traces.join("; "));
  const logs = api.takeLogs();
  check("no request of this run was answered with a server error", seen.every(({ response }) => response.status < 500) && !/status=5\d\d/.test(logs.text), logs.text.slice(0, 300));
}

await api.close();
const ok = report();
if (ok) console.log("\nAll API checks passed.");
process.exit(ok ? 0 : 1);
