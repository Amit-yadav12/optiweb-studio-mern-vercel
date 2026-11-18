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
 *  - When the site reports direct uploads: does a background job work end to
 *    end? The script creates a job, uploads one file straight to object
 *    storage with the authorization the site issues (Vercel Blob, or the
 *    local driver on a development server), confirms it, follows the job and
 *    downloads the result. This is the only check here that exercises the
 *    real storage service.
 *
 * It uploads small generated images and changes nothing else. Database
 * readiness is reported but does not fail the run, because conversion and
 * download work without a database.
 */
import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { put } from "@vercel/blob/client";
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

/* ------------------------------------------------- direct upload and job */
const capacity = limits.json?.data?.image;
if (capacity?.mode === "direct") {
  section("direct upload: job, upload to object storage, worker, download");
  let cookie = "";
  /** A JSON request in one guest session, as a browser's cookie jar gives it. */
  const api = async (method, pathname, body) => {
    const response = await request(pathname, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    cookie ||= (response.headers?.get("set-cookie") ?? "").split(";")[0];
    return response;
  };
  const picture = await jpegImage(640, 400, { r: 200, g: 120, b: 40 });
  const created = await api("POST", "/api/v1/jobs/image-optimization", { files: [{ name: "smoke-direct.jpg", type: "image/jpeg", size: picture.length }], settings: { format: "webp" } });
  const item = created.json?.data?.job?.items?.[0];
  check("a job is created for one file", created.status === 201 && typeof item?.id === "string", `${seen(created)}${created.json?.error?.code ? `, ${created.json.error.code}` : ""}`);

  const token = item ? await api("POST", "/api/v1/uploads/token", { uploadId: item.id }) : null;
  const grant = token?.json?.data?.upload;
  check("an upload authorization is issued", token?.status === 200 && (grant?.transport === "vercel-blob" || grant?.transport === "local"), token ? seen(token) : "no job");

  let sent = "not sent";
  if (grant?.transport === "vercel-blob") {
    // The same call a browser makes: straight to the storage service, with the short-lived client token.
    sent = await put(grant.pathname, picture, { access: grant.access, token: grant.clientToken, contentType: grant.contentType, multipart: false }).then(() => "stored", (error) => `refused (${error?.name ?? "error"})`);
  } else if (grant?.transport === "local") {
    const stored = await request(grant.uploadUrl, { method: "PUT", headers: { cookie, "content-type": grant.contentType }, body: picture });
    sent = stored.status === 200 ? "stored" : `refused (${seen(stored)})`;
  }
  check(`the file is uploaded straight to object storage (${grant?.transport ?? "no transport"})`, sent === "stored", sent);

  const confirmed = item ? await api("POST", "/api/v1/uploads/complete", { uploadId: item.id }) : null;
  check("the upload is confirmed and the job is handed to the worker", confirmed?.status === 202 && confirmed.json?.data?.queued === true, confirmed ? `${seen(confirmed)}${confirmed.json?.error?.code ? `, ${confirmed.json.error.code}` : ""}` : "no job");

  let job = confirmed?.json?.data?.job ?? null;
  const jobDeadline = Date.now() + 120_000;
  while (job && !["completed", "partial", "failed", "cancelled"].includes(job.state) && Date.now() < jobDeadline) {
    await sleep(1_500);
    job = (await api("GET", `/api/v1/jobs/${job.id}`)).json?.data?.job ?? job;
  }
  const converted = job?.items?.[0];
  check("the worker converts the file", job?.state === "completed" && converted?.state === "completed" && converted.result?.outputFormat === "webp", `job ${job?.state ?? "missing"}${converted?.errorCode ? `, ${converted.errorCode}` : ""}`);

  const fetched = converted?.artifactId ? await request(`/api/v1/artifacts/${converted.artifactId}?download=1`, { headers: { cookie } }) : null;
  const picked = fetched?.status === 200 ? await sharp(fetched.bytes).metadata().catch(() => null) : null;
  check("the result is streamed back to the session that owns it", fetched?.status === 200 && fetched.bytes.length === converted.result.outputBytes && picked?.format === "webp" && picked.width === 640, fetched ? `${seen(fetched)}, ${fetched.bytes.length} bytes` : "no artifact");
  const stranger = converted?.artifactId ? await request(`/api/v1/artifacts/${converted.artifactId}?download=1`) : null;
  check("a request without that session does not get the file", stranger?.status === 404, stranger ? seen(stranger) : "no artifact");
  if (job?.state === "completed") note(`direct upload via ${grant?.transport}: ${picture.length} → ${converted.result.outputBytes} bytes in a background job`);
} else if (apiDeployed) {
  note(`direct uploads are not in effect (${capacity?.directUnavailableReason ?? "the site does not report a mode"}); the standard upload was tested`);
}

const ok = report();
process.exit(ok ? 0 : 1);
