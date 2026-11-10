#!/usr/bin/env node
/**
 * Smoke test for a running site. It uses only public HTTP requests, so it can
 * be pointed at production, a preview or a local server.
 *
 *   node scripts/deployed-smoke.mjs <base-url> [--expect-build] [--wait <seconds>]
 *
 * It answers the questions a broken deployment raises:
 *
 *  - Is the site serving this build? With `--expect-build` the app script the
 *    page loads is compared with the one in the local `dist/` (run
 *    `npm run build` first). `--wait` keeps checking for that many seconds, for
 *    a deployment that is still in progress. A site left on a deployment with
 *    different browser code fails here. Two deployments that differ only in
 *    server code load the same script, so this comparison cannot tell them
 *    apart; the API checks below then describe whichever one is live.
 *  - Does a deep link such as /app/images load the app?
 *  - Is the API deployed? Every /api path must answer with the API's JSON. A
 *    host's own "not found" page means the server function is missing.
 *  - Can an image be converted and the converted file downloaded: by URL when
 *    it was stored, or from the response when it was not?
 *
 * It uploads one small generated image and changes nothing else. Database
 * readiness is reported but does not fail the run, because conversion and
 * download work without a database.
 */
import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { createChecker, imageForm, jpegImage } from "./lib/selftest-kit.mjs";

const args = process.argv.slice(2);
const base = (args.find((arg) => /^https?:\/\//.test(arg)) ?? "").replace(/\/+$/, "");
const expectBuild = args.includes("--expect-build");
const waitIndex = args.indexOf("--wait");
const waitSeconds = waitIndex >= 0 ? Number(args[waitIndex + 1]) || 0 : 0;

if (!base) {
  console.error("Usage: node scripts/deployed-smoke.mjs <base-url> [--expect-build] [--wait <seconds>]");
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
    return { status: 0, type: "", bytes: Buffer.alloc(0), json: null, headers: null, text: "", error: error instanceof Error ? error.name : "request failed" };
  }
}

/** What a response was, in a few words, for a failure message. */
const seen = (response) => (response.status === 0 ? `no response (${response.error})` : `HTTP ${response.status}, ${response.type || "no content type"}`);

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
    `expected ${expected}, the site serves ${served ?? "no app script"}. If the deployment of this commit has finished, another deployment is assigned to this address: promote the new one in the hosting dashboard. A build made with different VITE_* variables also has a different script name.`,
  );
}

const deepLink = await request("/app/images");
check("a deep link (/app/images) loads the same app", deepLink.status === 200 && served !== null && deepLink.text.includes(served), seen(deepLink));

/* ----------------------------------------------------------------- the API */
section("the API");
const health = await request("/api/v1/health");
const database = health.json?.data?.database;
const apiDeployed = check(
  "/api/v1/health answers with the API's JSON",
  health.status === 200 && health.json?.ok === true && typeof database === "object" && database !== null,
  `${seen(health)}. An answer that is not JSON comes from the host: the server function is not deployed.`,
);
const unknown = await request("/api/v1/does-not-exist");
check("an unknown /api path is answered by the API, not by the host", unknown.status === 404 && unknown.json?.error?.code === "not_found", seen(unknown));
const limits = await request("/api/v1/limits");
check("/api/v1/limits reports the upload limits", limits.status === 200 && Number.isFinite(limits.json?.data?.maxFilesPerRequest), seen(limits));

const databaseReady = database?.ready ?? database?.connected ?? false;
if (apiDeployed) note(`database ${databaseReady ? "ready" : `not ready${database?.category ? ` (${database.category})` : ""}`}`);

/* -------------------------------------------------- convert and download */
section("convert an image and download the result");
const source = await jpegImage(320, 200, { r: 36, g: 92, b: 230 });
const upload = await request("/api/v1/images/optimize", { method: "POST", body: imageForm([{ name: "smoke-test.jpg", data: source, type: "image/jpeg" }], { format: "webp" }) });
const data = upload.json?.data;
const result = data?.results?.[0];
check("the upload is converted to WebP", upload.status === 200 && result?.status === "completed" && result.outputFormat === "webp" && result.outputBytes > 0, `${seen(upload)}${upload.json?.error?.code ? `, ${upload.json.error.code}` : ""}`);

let file = null;
let route = "no download offered";
if (data?.persisted === true && typeof result?.artifactId === "string") {
  // Stored: the file is served by URL to the session that uploaded it.
  const cookie = (upload.headers?.get("set-cookie") ?? "").split(";")[0];
  const download = await request(`/api/v1/artifacts/${result.artifactId}?download=1`, { headers: cookie ? { cookie } : {} });
  route = `stored, downloaded by URL (${seen(download)})`;
  file = download.status === 200 ? download.bytes : null;
} else if (data?.persisted === false && result?.inlineOutput?.encoding === "base64") {
  // Not stored: the file came inside the response.
  route = `not stored${data.storage?.category ? ` (${data.storage.category})` : ""}, sent with the response`;
  file = Buffer.from(result.inlineOutput.data, "base64");
}
const image = file ? await sharp(file).metadata().catch(() => null) : null;
check(
  "the converted file can be downloaded and is the image the result describes",
  file !== null && file.length === result?.outputBytes && image?.format === "webp" && image.width === result.outputWidth && image.height === result.outputHeight,
  `${route}: ${file?.length ?? 0} bytes, ${image?.format ?? "not an image"}; the result reports ${result?.outputBytes ?? "no"} bytes`,
);
if (file) note(`converted ${source.length} → ${file.length} bytes; ${route}`);

const ok = report();
process.exit(ok ? 0 : 1);
