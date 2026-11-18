#!/usr/bin/env node
/**
 * Self-test of the Image Optimizer screen in direct-upload mode, in a DOM.
 *
 *   npm run test:dom:direct
 *
 * The real screen is mounted in jsdom and used the way a person does: choose
 * files, press "Optimize", watch the progress, download. Its requests go to
 * the real API in this process, with the local storage driver and either
 * MongoDB (when MONGODB_URI names a throwaway database) or the in-memory
 * stand-in. The worker is started by the API itself, as in production.
 *
 * The one piece that is replaced is the transfer of a file to storage: jsdom
 * has no working upload with progress events, so the test sends the file to
 * the same address and reports progress in two steps. The storage client that
 * runs in a browser is therefore not exercised here.
 */
import { clearInterval, setInterval } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { createChecker, startApi } from "./lib/selftest-kit.mjs";
import { photoJpeg, preparePipelineEnvironment, transparentPng } from "./lib/pipeline-kit.mjs";
import { createDom, createModuleLoader } from "./lib/dom-kit.mjs";

const { check, section, report, crashed } = createChecker("optimizer-direct-dom-selftest");
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

const env = await preparePipelineEnvironment({ OW_JOB_TRIGGER: "inline", OW_MAX_FILE_MB: "2", OW_MAX_BATCH_MB: "3", OW_MAX_FILES: "4" });
console.log(`database: ${env.database}`);
const api = await startApi();
const dom = createDom();
const { document, text, html, waitFor, press, chooseFiles, findButton, buttonLabels, downloads } = dom;
const { workerIdle } = await import("../src/server/pipeline/trigger.ts");

/* ------------------------------------------------------------ the transport */
// One guest session for the whole page, as a browser's cookie jar gives it.
let cookie = null;
const requests = [];
async function apiCall(method, pathname, body) {
  requests.push(`${method} ${pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")}`);
  const response = await fetch(`${api.base}${pathname}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  cookie ??= (response.headers.get("set-cookie") ?? "").split(";")[0] || null;
  const envelope = await response.json();
  if (!response.ok || envelope.ok === false) throw Object.assign(new Error(envelope.error?.message ?? "request failed"), { code: envelope.error?.code, hint: envelope.error?.hint, status: response.status });
  return envelope.data;
}
const jobApi = { post: (pathname, body) => apiCall("POST", pathname, body), get: (pathname) => apiCall("GET", pathname), del: (pathname) => apiCall("DELETE", pathname) };

/** What the next uploads should do. Set by a test before it presses the button. */
let uploadPlan = { delayMs: 0, fail: () => false };
const uploads = [];
async function upload(grant, file, { signal, onProgress }) {
  uploads.push({ name: file.name, transport: grant.transport });
  if (uploadPlan.fail(file.name)) throw Object.assign(new Error("The upload was interrupted by a network error."), { aborted: false });
  onProgress({ loaded: Math.floor(file.size / 2), total: file.size });
  if (uploadPlan.delayMs > 0) await sleep(uploadPlan.delayMs, undefined, { signal }).catch(() => { throw Object.assign(new Error("The upload was cancelled."), { aborted: true }); });
  const response = await fetch(`${api.base}${grant.uploadUrl}`, { method: "PUT", headers: { cookie, "content-type": grant.contentType }, body: Buffer.from(await file.arrayBuffer()), signal });
  if (!response.ok) throw Object.assign(new Error(`Storage refused the upload (HTTP ${response.status}).`), { status: response.status });
  onProgress({ loaded: file.size, total: file.size });
}

const loader = await createModuleLoader();
const { mountImageOptimizer } = await loader.load("/scripts/lib/mount-image-optimizer.tsx");
const limits = { mode: "direct", maxFileMb: 2, maxFiles: 4, maxBatchMb: 3, maxDecodedPixels: 40_000_000, avifSupported: false, sourceTtlHours: 24, artifactTtlHours: 720 };
const mount = () => mountImageOptimizer(document.getElementById("root"), limits, { api: jobApi, upload });
const imageFile = (data, name, type) => new File([data], name, { type });
const get = async (pathname) => {
  const response = await fetch(`${api.base}${pathname}`, { headers: { cookie } });
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()), type: response.headers.get("content-type") };
};
/** Collects the progress line while a job runs. */
function watchProgress() {
  const seen = new Set();
  const timer = setInterval(() => {
    const line = document.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, " ").trim();
    if (line) seen.add(line.replace(/[\d.]+ (B|KB|MB)/g, "N").replace(/\d+/g, "N"));
  }, 5);
  return { seen, stop: () => clearInterval(timer) };
}

const photo = await photoJpeg(900, 600);
const alpha = await transparentPng(200);
const corrupt = Buffer.concat([photo.subarray(0, 300), Buffer.alloc(4000)]);

/* ================================================================ 1. a job */
section("three files, one of them corrupt: upload, convert, download");
let screen = mount();
await waitFor(() => document.querySelector('input[type="file"]') !== null);
check("the screen states the direct-upload limits it was given", text().includes("2 MB per file · 4 files per batch · 3 MB per batch") && text().includes("uploaded straight to private storage"), text().slice(0, 400));
chooseFiles([imageFile(photo, "photo.jpg", "image/jpeg"), imageFile(alpha, "alpha.png", "image/png"), imageFile(corrupt, "broken.jpg", "image/jpeg")]);
await waitFor(() => findButton("Optimize 3 files") !== null);
check("the queue shows the batch total against the batch limit", document.querySelector('[data-testid="batch-total"]')?.textContent?.replace(/\s+/g, " ").includes("3 files") && document.querySelector('[data-testid="batch-total"]').textContent.includes("of 3 MB per batch"), document.querySelector('[data-testid="batch-total"]')?.textContent);
uploadPlan = { delayMs: 60, fail: () => false };
const progress = watchProgress();
press("Optimize 3 files");
const finished = await waitFor(() => text().includes("Review results") || text().includes("converted") && findButton(/^Optimize another/) !== null, 30_000);
progress.stop();
await waitFor(() => html().includes("/api/v1/artifacts/"));
check("the job runs to its end without any further action", finished && html().includes("/api/v1/artifacts/"), text().slice(0, 300));
check("uploads went straight to storage, one authorization and one confirmation per file", uploads.length === 3 && uploads.every((entry) => entry.transport === "local") && requests.filter((request) => request === "POST /api/v1/uploads/token").length === 3 && requests.filter((request) => request === "POST /api/v1/uploads/complete").length === 3 && requests.filter((request) => request === "POST /api/v1/jobs/image-optimization").length === 1, `${uploads.length} uploads; ${requests.slice(0, 8).join(", ")}`);
check("no file was sent through the request-body endpoint", !requests.some((request) => request.includes("/api/v1/images/optimize")));
const lines = [...progress.seen];
check("progress is reported in real units: bytes sent while uploading, files finished while converting", lines.some((line) => /^Uploading: N of N files uploaded · N of N sent$/.test(line)) && lines.some((line) => /(Converting|Waiting in the queue) · N of N files finished$/.test(line)), lines.join(" | "));
check("no percentage is shown anywhere while the job runs", !lines.some((line) => line.includes("%")), lines.join(" | "));

const links = Array.from(document.querySelectorAll("a[download], a[href*='/api/v1/artifacts/']")).map((anchor) => anchor.getAttribute("href")).filter((href) => /\/api\/v1\/artifacts\/[0-9a-f-]{36}\?download=1/.test(href ?? ""));
const unique = [...new Set(links)];
check("the two converted files are offered as downloads by URL; the corrupt file is not", unique.length === 2, unique.join(", "));
const files = await Promise.all(unique.map((href) => get(href)));
const metas = await Promise.all(files.map((file) => sharp(file.bytes).metadata().catch(() => null)));
check("each link downloads a real WebP of the right size", files.every((file) => file.status === 200 && file.type === "image/webp") && metas.map((meta) => `${meta?.width}x${meta?.height}`).sort().join() === "200x200,900x600", metas.map((meta) => `${meta?.format} ${meta?.width}x${meta?.height}`).join(", "));
check("the outcome is stated as converted and stored, with the rejected file and its reason", /stored/i.test(text()) && text().includes("broken.jpg") && /not a readable image|could not be re-encoded|not be processed|unreadable/i.test(text()), text().slice(0, 500));
check("the files are stored on the server: nothing is described as kept only in this tab", !/kept only in this tab|Not stored/.test(text()));

const before = downloads.length;
press("Download all (ZIP)");
await waitFor(() => downloads.length > before);
const zipLink = downloads.at(-1);
const zip = zipLink ? await get(zipLink.href) : null;
check("\"Download all (ZIP)\" is a plain link to a streamed archive of both files", /^\/api\/v1\/artifacts\/zip\?ids=[0-9a-f-]{36},[0-9a-f-]{36}&name=optiweb-images$/.test(zipLink?.href ?? "") && zip?.status === 200 && zip.type === "application/zip" && zip.bytes.subarray(0, 2).toString() === "PK", `${zipLink?.href} → ${zip?.status}`);
screen.unmount();

/* ============================================================== 2. cancel */
section("cancelling during the upload");
document.getElementById("root").replaceChildren();
screen = mount();
await waitFor(() => document.querySelector('input[type="file"]') !== null);
chooseFiles([imageFile(photo, "one.jpg", "image/jpeg"), imageFile(alpha, "two.png", "image/png")]);
await waitFor(() => findButton("Optimize 2 files") !== null);
uploadPlan = { delayMs: 3_000, fail: () => false };
const objectsBefore = (await env.listObjects()).length;
press("Optimize 2 files");
await waitFor(() => findButton("Cancel") !== null && uploads.length >= 4);
press("Cancel");
const cancelled = await waitFor(() => text().includes("Job cancelled") && findButton("Optimize 2 files") !== null, 15_000);
check("Cancel stops the upload and the job, and the queue is as it was", cancelled && requests.some((request) => request === "POST /api/v1/jobs/:id/cancel"), buttonLabels().join(" | "));
check("the cancelled job left nothing in storage", (await env.listObjects()).length === objectsBefore, `${(await env.listObjects()).length} objects, ${objectsBefore} before`);
screen.unmount();

/* ====================================================== 3. a failed upload */
section("an upload that keeps failing");
document.getElementById("root").replaceChildren();
screen = mount();
await waitFor(() => document.querySelector('input[type="file"]') !== null);
chooseFiles([imageFile(photo, "arrives.jpg", "image/jpeg"), imageFile(alpha, "fails.png", "image/png")]);
await waitFor(() => findButton("Optimize 2 files") !== null);
uploadPlan = { delayMs: 0, fail: (name) => name === "fails.png" };
const attemptsBefore = uploads.filter((entry) => entry.name === "fails.png").length;
press("Optimize 2 files");
const stalled = await waitFor(() => text().includes("Some uploads did not finish"), 20_000);
check("after three attempts the screen says which uploads did not finish, and offers to retry or continue", stalled && uploads.filter((entry) => entry.name === "fails.png").length - attemptsBefore === 3 && findButton("Retry uploads") !== null && findButton("Continue without them") !== null && text().includes("1 file could not be uploaded"), buttonLabels().join(" | "));
press("Continue without them");
const continued = await waitFor(() => html().includes("?download=1"), 20_000);
const afterSkip = [...new Set(Array.from(document.querySelectorAll("a")).map((anchor) => anchor.getAttribute("href")).filter((href) => /\/api\/v1\/artifacts\/[0-9a-f-]{36}\?download=1/.test(href ?? "")))];
check("continuing removes the failed file from the job and converts the one that arrived", continued && afterSkip.length === 1 && requests.some((request) => request === "DELETE /api/v1/uploads/:id"), `${afterSkip.length} downloads`);
screen.unmount();

/* ============================================================ 4. the limits */
section("limits of a batch, before anything is sent");
document.getElementById("root").replaceChildren();
screen = mount();
await waitFor(() => document.querySelector('input[type="file"]') !== null);
const sent = requests.length;
const big = Buffer.alloc(1_600_000, 1);
chooseFiles([imageFile(big, "a.png", "image/png"), imageFile(big, "b.png", "image/png"), imageFile(Buffer.alloc(2_200_000, 1), "huge.png", "image/png")]);
await waitFor(() => findButton("Optimize 1 file") !== null);
check("a file above the per-file limit and a file beyond the batch size are not queued, and the screen says why", findButton("Optimize 1 file") !== null && text().includes("over the size limit") && text().includes("A batch holds at most 3 MB in total"), text().slice(0, 400));
check("nothing was requested for the refused files", requests.length === sent || requests.slice(sent).every((request) => request.startsWith("GET ")), requests.slice(sent).join(", "));
screen.unmount();
await sleep(50);

section("the page");
const pageLog = api.takeLogs().lines.filter((line) => !line.startsWith("{"));
check("the page logged no error or warning", pageLog.length === 0 && dom.pageErrors.length === 0, [...pageLog, ...dom.pageErrors].join(" | ").slice(0, 300));

await workerIdle();
await loader.close();
await api.close();
await env.close();
const ok = report();
if (ok) console.log("\nAll direct-upload screen checks passed.");
process.exit(ok ? 0 : 1);
