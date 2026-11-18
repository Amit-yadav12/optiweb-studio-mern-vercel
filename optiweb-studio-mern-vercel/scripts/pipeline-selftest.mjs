#!/usr/bin/env node
/**
 * Self-test of the direct-upload pipeline, through the HTTP API.
 *
 *   npm run test:pipeline
 *
 * A browser's part is played with plain requests: create a job, ask for an
 * upload authorization, send the file straight to storage, confirm it, poll
 * the job, download the results. Storage is the local disk driver, which
 * gives the server the same contract as Vercel Blob. The database is MongoDB
 * when MONGODB_URI names a throwaway database (CI does this), and an
 * in-memory stand-in otherwise.
 *
 * What a pass does not show: that Vercel Blob itself behaves as its SDK
 * documents, or that MongoDB accepts the queries when the stand-in was used.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import JSZip from "jszip";
import sharp from "sharp";
import { createChecker, startApi } from "./lib/selftest-kit.mjs";
import { animatedGif, photoJpeg, pngOfSize, preparePipelineEnvironment, transparentPng } from "./lib/pipeline-kit.mjs";

const { check, section, report, crashed } = createChecker("pipeline-selftest");
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

const MB = 1024 * 1024;
const CRON_SECRET = "selftest-cron-secret-0123456789";
// Small limits, so that every limit can be reached with small files.
const env = await preparePipelineEnvironment({
  OW_MAX_FILE_MB: "2",
  OW_MAX_BATCH_MB: "5",
  OW_MAX_FILES: "4",
  OW_MAX_DECODED_PIXELS: "2000000",
  OW_MAX_TOTAL_BATCH_PIXELS: "3000000",
  OW_MAX_ZIP_MB: "1",
  OW_SESSION_STORAGE_QUOTA_MB: "8",
  OW_MAX_ACTIVE_JOBS_PER_SESSION: "2",
  OW_MAX_JOB_RETRIES: "2",
  OW_JOB_LEASE_SECONDS: "30",
  CRON_SECRET,
});
console.log(`database: ${env.database}`);
if (process.env.GITHUB_ACTIONS === "true") console.log(`::notice title=pipeline-selftest::database: ${env.database}`);

const api = await startApi();
const { drainJobs } = await import("../src/server/pipeline/worker.ts");
const { runCleanup } = await import("../src/server/pipeline/cleanup.ts");
const { workerIdle } = await import("../src/server/pipeline/trigger.ts");
const { resetRateLimits } = await import("../src/server/middleware/rateLimit.ts");
const { getObjectStorage, setObjectStorageForTests, ObjectStorageError } = await import("../src/server/storage/objectStorage.ts");
const { ownerKey, isOwnedPath, pathSegment } = await import("../src/server/storage/objectPaths.ts");
const { createLocalStorage } = await import("../src/server/storage/localStorage.ts");
const { sniffSignature, rasterContentType } = await import("../src/server/pipeline/signature.ts");
const { zipChunks, zipLength } = await import("../src/server/pipeline/zipStream.ts");
const { stableUuid } = await import("../src/server/pipeline/ids.ts");
const store = env.store;
const storage = await getObjectStorage();

/* ------------------------------------------------------------------ helpers */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Checks that could not run in this environment, with the reason. Reported at the end. */
const skipped = [];
const everything = [];
/** One API call. Every response is kept, so that the whole run can be scanned for leaks at the end. */
async function call(pathname, { cookie, json, ...init } = {}) {
  const response = await api.call(pathname, {
    cookie,
    ...init,
    ...(json !== undefined ? { method: init.method ?? "POST", headers: { "content-type": "application/json", ...(init.headers ?? {}) }, body: JSON.stringify(json) } : {}),
  });
  everything.push(response.visible);
  return response;
}
/** A new guest session, as a Cookie header value. */
async function newSession() {
  const response = await call("/api/v1/session");
  return response.sessionCookie;
}
const sessionIdOf = (cookie) => cookie.split("=")[1];
/** Windows of both rate limiters are cleared between sections, so that sections do not depend on each other. */
async function resetLimits() {
  resetRateLimits();
  await store.rate.deleteMany({});
}
const fileSpec = (name, data, type) => ({ name, type, size: data.length, data });
const createJob = (cookie, files, settings = {}, extra = {}) =>
  call("/api/v1/jobs/image-optimization", { cookie, json: { files: files.map(({ name, type, size }) => ({ name, type, size })), settings, ...extra } });
const tokenFor = (cookie, uploadId) => call("/api/v1/uploads/token", { cookie, json: { uploadId } });
/** Sends a file to the address in an upload grant, the way a browser does: straight to storage, not through the API's body parser. */
async function putTo(grant, data, { cookie, contentType } = {}) {
  const response = await fetch(`${api.base}${grant.uploadUrl}`, { method: "PUT", headers: { "content-type": contentType ?? grant.contentType, ...(cookie ? { cookie } : {}) }, body: data });
  const text = await response.text();
  everything.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json };
}
const completeUpload = (cookie, uploadId) => call("/api/v1/uploads/complete", { cookie, json: { uploadId } });
const getJob = async (cookie, jobId) => (await call(`/api/v1/jobs/${jobId}`, { cookie })).json?.data?.job;
/** Creates a job and uploads and confirms every file. Returns the job as the last confirmation reported it. */
async function submit(cookie, files, settings = {}, extra = {}) {
  const created = await createJob(cookie, files, settings, extra);
  if (created.status !== 201 && created.status !== 200) return { created, job: null, last: null };
  let last = null;
  for (const [index, item] of created.json.data.job.items.entries()) {
    const token = await tokenFor(cookie, item.id);
    await putTo(token.json.data.upload, files[index].data, { cookie });
    last = await completeUpload(cookie, item.id);
  }
  return { created, job: last?.json?.data?.job ?? created.json.data.job, last };
}
const download = (cookie, artifactId, query = "") => call(`/api/v1/artifacts/${artifactId}${query}`, { cookie });
/**
 * Whether a request for someone else's file was denied. With MongoDB that is
 * always 404 (or 400 for an empty ZIP selection). Without it, the lookup of
 * files that are stored in the database itself cannot run and answers 503;
 * that is still a denial, and the check that no bytes were sent is separate.
 */
const denied = (response) => response.status === 404 || response.status === 400 || (!env.usingMongo && response.status === 503 && response.json?.error?.code === "storage_unavailable");
const usageOf = async (cookie) => (await call("/api/v1/usage", { cookie })).json?.data;
const itemsOf = (jobId) => store.items.find({ jobId }, { sort: { index: 1 } });

const jpegSmall = await photoJpeg(640, 480);
const jpegOther = await photoJpeg(800, 500, { sigma: 22 });
const pngAlpha = await transparentPng(128);
const gif = await animatedGif(3, 48);
const webpSource = await sharp(jpegSmall).webp({ quality: 90 }).toBuffer();

/* ============================================================ 1. the happy path */
section("one file: create, authorize, upload directly, confirm, process, download");
const alice = await newSession();
{
  const limits = (await call("/api/v1/limits", { cookie: alice })).json?.data;
  check("limits report direct mode with the configured capacity", limits?.image?.mode === "direct" && limits.image.maxFileBytes === 2 * MB && limits.image.maxFiles === 4 && limits.image.maxBatchBytes === 5 * MB && limits.image.sessionQuotaBytes === 8 * MB, JSON.stringify(limits?.image));
  check("advanced capacity is reported as not enabled", limits?.advancedCapacity?.enabled === false && typeof limits.advancedCapacity.reason === "string");

  const file = fileSpec("Holiday Photo.jpg", jpegSmall, "image/jpeg");
  const created = await createJob(alice, [file], { format: "webp", quality: 80 });
  const job = created.json?.data?.job;
  const item = job?.items?.[0];
  check("the job is created (201) in state `created`, with one file awaiting upload", created.status === 201 && UUID.test(job?.id ?? "") && job.state === "created" && job.counts.total === 1 && job.counts.awaitingUpload === 1 && item?.state === "awaiting_upload" && item.bytes === jpegSmall.length, `status ${created.status}, ${job?.state}`);
  check("the response names no storage path and no token", !created.visible.includes("src/") && !/clientToken|uploadUrl/.test(created.visible));

  const token = await tokenFor(alice, item.id);
  const grant = token.json?.data?.upload;
  check("an upload authorization is issued for that file only: size, content type, expiry", token.status === 200 && grant?.uploadId === item.id && grant.bytes === jpegSmall.length && grant.contentType === "image/jpeg" && Date.parse(grant.expiresAt) > Date.now() && Date.parse(grant.expiresAt) <= Date.now() + 21 * 60_000, JSON.stringify({ ...grant, uploadUrl: "…" }));
  check("the job is now `uploading`", (await getJob(alice, job.id))?.state === "uploading");
  const before = await usageOf(alice);
  check("the file's size is reserved in the session's quota before it is uploaded", before?.reservedBytes === jpegSmall.length && before.sourceBytes === 0 && before.activeJobs === 1, JSON.stringify(before && { reserved: before.reservedBytes, source: before.sourceBytes, active: before.activeJobs }));

  const early = await completeUpload(alice, item.id);
  check("confirming before the file has arrived is refused (409), and changes nothing", early.status === 409 && early.json?.error?.code === "conflict" && (await getJob(alice, job.id))?.items[0].state === "awaiting_upload", `status ${early.status}`);

  const put = await putTo(grant, jpegSmall, { cookie: alice });
  check("the browser's upload goes straight to storage and is accepted", put.status === 200 && put.json?.data?.bytes === jpegSmall.length, `status ${put.status}`);
  const done = await completeUpload(alice, item.id);
  check("confirming the last file queues the job and answers 202", done.status === 202 && done.json?.data?.queued === true && done.json.data.job.state === "queued" && done.json.data.job.counts.waiting === 1, `status ${done.status}, ${done.json?.data?.job?.state}`);
  const after = await usageOf(alice);
  check("the reservation became stored source bytes", after?.reservedBytes === 0 && after.sourceBytes === jpegSmall.length && after.files.sources === 1, JSON.stringify(after && { reserved: after.reservedBytes, source: after.sourceBytes }));

  const again = await completeUpload(alice, item.id);
  const afterAgain = await usageOf(alice);
  check("a repeated confirmation answers 200 and counts nothing twice", again.status === 200 && again.json?.data?.queued === false && afterAgain?.sourceBytes === jpegSmall.length && afterAgain.lifetime.uploads === 1, `status ${again.status}, uploads ${afterAgain?.lifetime?.uploads}`);

  const run = await drainJobs();
  const finished = await getJob(alice, job.id);
  const result = finished?.items?.[0];
  check("the worker claims the job, converts the file and finishes the job", run.claimed === 1 && run.finished === 1 && run.itemsCompleted === 1 && finished?.state === "completed" && finished.counts.completed === 1, JSON.stringify(run));
  check("the result reports measured sizes and dimensions", result?.state === "completed" && result.result?.outputFormat === "webp" && result.result.outputBytes > 0 && result.result.inputBytes === jpegSmall.length && result.result.savedBytes === jpegSmall.length - result.result.outputBytes && result.result.outputWidth === 640 && result.result.outputHeight === 480 && result.result.outputFilename === "Holiday-Photo-optiweb.webp", JSON.stringify(result?.result));
  check("job totals are the sums over the converted files", finished?.totals.inputBytes === jpegSmall.length && finished.totals.outputBytes === result?.result?.outputBytes && finished.totals.savedBytes === result.result.savedBytes);

  const file1 = await download(alice, result.artifactId);
  const meta = await sharp(file1.bytes).metadata().catch(() => null);
  check("the generated file downloads as an attachment with exactly the reported bytes", file1.status === 200 && file1.bytes.length === result.result.outputBytes && file1.headers.get("content-type") === "image/webp" && file1.headers.get("content-length") === String(result.result.outputBytes) && /^attachment; filename="Holiday-Photo-optiweb\.webp"/.test(file1.headers.get("content-disposition") ?? "") && (file1.headers.get("cache-control") ?? "").includes("no-store"), `status ${file1.status}, ${file1.bytes.length} bytes`);
  check("it decodes as the image the result describes", meta?.format === "webp" && meta.width === 640 && meta.height === 480);
  check("the internal streaming marker is not sent to the client", file1.headers.get("x-optiweb-stream") === null);
  const inline = await download(alice, result.artifactId, "?inline=1");
  check("?inline=1 serves the same bytes for a preview", inline.status === 200 && inline.bytes.equals(file1.bytes) && (inline.headers.get("content-disposition") ?? "").startsWith("inline"));
  const status = await call(`/api/v1/artifacts/${result.artifactId}/status`, { cookie: alice });
  check("the artifact status endpoint reports it as available, with its expiry", status.status === 200 && status.json?.data?.state === "available" && status.json.data.bytes === result.result.outputBytes && Date.parse(status.json.data.expiresAt) > Date.now() + 29 * 86_400_000, JSON.stringify(status.json?.data));

  const usage = await usageOf(alice);
  check("usage counts the source and the generated file, and the job slot is free again", usage?.sourceBytes === jpegSmall.length && usage.artifactBytes === result.result.outputBytes && usage.activeJobs === 0 && usage.files.artifacts === 1 && usage.usedBytes === usage.sourceBytes + usage.artifactBytes && usage.remainingBytes === 8 * MB - usage.usedBytes, JSON.stringify(usage && { source: usage.sourceBytes, artifact: usage.artifactBytes, active: usage.activeJobs }));

  const objects = await env.listObjects();
  const key = ownerKey(sessionIdOf(alice));
  check("storage holds exactly the source and the generated file, under the session's own prefix", objects.length === 2 && objects.every((object) => object.startsWith(`src/${key}/`) || object.startsWith(`out/${key}/`)), objects.join(", "));
  check("no storage path contains the session ID", !objects.some((object) => object.includes(sessionIdOf(alice))));

  // History is read through the application's MongoDB models, so it needs a real database.
  if (env.usingMongo) {
    const history = await call("/api/v1/history?page=1&pageSize=5", { cookie: alice });
    const entry = history.json?.data?.entries?.find((candidate) => candidate.id === job.id);
    check("History lists the job as completed, with its file and artifact", entry?.status === "completed" && entry.fileCount === 1 && entry.artifactIds?.length === 1 && entry.artifactIds[0] === result.artifactId && entry.savedBytes === result.result.savedBytes, JSON.stringify(entry));
    const detail = await call(`/api/v1/history/${job.id}`, { cookie: alice });
    check("the History detail reports the file with its stored output", detail.status === 200 && detail.json?.data?.items?.length === 1 && detail.json.data.items[0].hasArtifact === true && detail.json.data.items[0].outputFormat === "webp");
  } else {
    skipped.push("History list and detail of a background job (needs MongoDB)");
  }
}

/* ======================================================= 2. limits at admission */
section("admission: every limit is enforced before anything is uploaded");
await resetLimits();
{
  const bob = await newSession();
  const tiny = await pngOfSize(2_000);
  const objectsBefore = (await env.listObjects()).length;
  const tooMany = await createJob(bob, Array.from({ length: 5 }, (_, index) => fileSpec(`f${index}.png`, tiny, "image/png")));
  check("more files than the job limit → 413 too_many_files", tooMany.status === 413 && tooMany.json?.error?.code === "too_many_files" && tooMany.json.error.message.includes("at most 4"), `status ${tooMany.status}`);
  const atLimit = { name: "exact.png", type: "image/png", size: 2 * MB };
  const overLimit = await call("/api/v1/jobs/image-optimization", { cookie: bob, json: { files: [{ ...atLimit, size: 2 * MB + 1 }] } });
  check("a file one byte above the per-file limit → 413 payload_too_large", overLimit.status === 413 && overLimit.json?.error?.code === "payload_too_large" && overLimit.json.error.message.includes("2 MB limit per file"), `status ${overLimit.status}`);
  const batch = await call("/api/v1/jobs/image-optimization", { cookie: bob, json: { files: [atLimit, { ...atLimit, name: "b.png" }, { ...atLimit, name: "c.png", size: MB + 1 }] } });
  check("a batch above the per-job size → 413 payload_too_large", batch.status === 413 && batch.json?.error?.message.includes("5 MB limit per job"), `status ${batch.status}`);
  const wrongType = await call("/api/v1/jobs/image-optimization", { cookie: bob, json: { files: [{ name: "notes.txt", type: "text/plain", size: 100 }] } });
  check("a file type outside the allowlist → 415", wrongType.status === 415 && wrongType.json?.error?.code === "unsupported_media_type", `status ${wrongType.status}`);
  const svg = await call("/api/v1/jobs/image-optimization", { cookie: bob, json: { files: [{ name: "logo.svg", type: "image/svg+xml", size: 100 }] } });
  check("SVG is not accepted for raster conversion → 415", svg.status === 415);
  const empty = await call("/api/v1/jobs/image-optimization", { cookie: bob, json: { files: [{ name: "a.png", type: "image/png", size: 0 }] } });
  const none = await call("/api/v1/jobs/image-optimization", { cookie: bob, json: { files: [] } });
  const badSettings = await call("/api/v1/jobs/image-optimization", { cookie: bob, json: { files: [atLimit], settings: { quality: 5 } } });
  check("an empty file, an empty batch and invalid settings → 422", empty.status === 422 && none.status === 422 && badSettings.status === 422, `${empty.status} ${none.status} ${badSettings.status}`);
  const usage = await usageOf(bob);
  check("a refused request reserves nothing and takes no job slot", usage?.reservedBytes === 0 && usage.activeJobs === 0 && usage.lifetime.jobs === 0 && (await env.listObjects()).length === objectsBefore, JSON.stringify(usage && { reserved: usage.reservedBytes, active: usage.activeJobs, jobs: usage.lifetime.jobs }));

  // Exactly at the per-file limit: accepted and processed.
  const exact = await pngOfSize(2 * MB);
  const { job, last } = await submit(bob, [fileSpec("exact.png", exact, "image/png")]);
  await drainJobs();
  const finished = await getJob(bob, job.id);
  check("a file of exactly the per-file limit is accepted and converted", last?.status === 202 && finished?.state === "completed" && finished.items[0].result?.inputBytes === 2 * MB, `${last?.status} ${finished?.state}`);
}

/* ============================================================= 3. the uploads */
section("uploads: the authorization is bound to one file, one size, one type, one session, and a short time");
await resetLimits();
{
  const carol = await newSession();
  const mallory = await newSession();
  const data = await pngOfSize(30_000);
  const created = await createJob(carol, [fileSpec("a.png", data, "image/png"), fileSpec("b.png", data, "image/png")]);
  const [first, second] = created.json.data.job.items;
  const grant = (await tokenFor(carol, first.id)).json.data.upload;

  const foreignToken = await tokenFor(mallory, first.id);
  check("another session cannot get an authorization for this upload (404)", foreignToken.status === 404, `status ${foreignToken.status}`);
  const noCookie = await putTo(grant, data);
  const foreignPut = await putTo(grant, data, { cookie: mallory });
  check("the upload address is refused without the owner's session, even with a valid signature", noCookie.status === 404 && foreignPut.status === 404, `${noCookie.status} ${foreignPut.status}`);
  const foreignComplete = await completeUpload(mallory, first.id);
  check("another session cannot confirm the upload (404)", foreignComplete.status === 404);

  const tampered = await putTo({ ...grant, uploadUrl: grant.uploadUrl.replace(/sig=[^&]+/, "sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") }, data, { cookie: carol });
  const extended = await putTo({ ...grant, uploadUrl: grant.uploadUrl.replace(/exp=\d+/, `exp=${Date.now() + 86_400_000}`) }, data, { cookie: carol });
  check("a forged signature or a changed expiry is refused (401)", tampered.status === 401 && extended.status === 401, `${tampered.status} ${extended.status}`);
  const otherFile = await putTo({ ...grant, uploadUrl: grant.uploadUrl.replace(first.id, second.id) }, data, { cookie: carol });
  check("an authorization cannot be used for another file of the same job (401)", otherFile.status === 401, `status ${otherFile.status}`);

  // An authorization that has run out. Issued directly, with a validity that is already over.
  const item = await store.items.findOne({ _id: first.id });
  const expired = await storage.authorizeUpload({ uploadId: item._id, path: item.path, contentType: item.contentType, maxBytes: item.declaredBytes, validUntil: Date.now() - 1_000, ttlDays: 1 });
  const late = await putTo({ ...expired, contentType: "image/png" }, data, { cookie: carol });
  check("an expired authorization is refused (401)", late.status === 401 && late.json?.error?.code === "unauthorized", `status ${late.status}`);

  const wrongType = await putTo(grant, data, { cookie: carol, contentType: "image/jpeg" });
  check("a content type other than the authorized one is refused (415)", wrongType.status === 415, `status ${wrongType.status}`);
  const tooBig = await putTo(grant, Buffer.concat([data, Buffer.alloc(1)]), { cookie: carol });
  check("one byte more than the authorized size is refused (413), and nothing is left in storage", tooBig.status === 413 && !(await env.objectExists(item.path)), `status ${tooBig.status}`);
  check("nothing above reached storage", (await store.items.findOne({ _id: first.id })).state === "awaiting_upload" && !(await env.objectExists(item.path)));

  // A smaller file than declared arrives: storage accepts it, the confirmation does not.
  await putTo(grant, data.subarray(0, 20_000), { cookie: carol });
  const short = await completeUpload(carol, first.id);
  const shortItem = short.json?.data?.job?.items?.[0];
  check("a file whose size differs from the declared size is rejected on confirmation and deleted", short.status === 200 && shortItem?.state === "failed" && shortItem.errorCode === "size_mismatch" && !(await env.objectExists(item.path)), `${short.status} ${shortItem?.errorCode}`);
  const afterReject = await tokenFor(carol, first.id);
  check("a rejected file gets no further authorization (409)", afterReject.status === 409);

  // The other file: correct size and type, but not an image.
  const grant2 = (await tokenFor(carol, second.id)).json.data.upload;
  const text = Buffer.alloc(data.length, "this is not an image. ");
  await putTo(grant2, text, { cookie: carol });
  const fake = await completeUpload(carol, second.id);
  const fakeItem = fake.json?.data?.job?.items?.[1];
  const path2 = (await store.items.findOne({ _id: second.id })).path;
  check("a file that is not an image is rejected by its signature and deleted", fakeItem?.state === "failed" && fakeItem.errorCode === "unsupported_media_type" && !(await env.objectExists(path2)), `${fakeItem?.state} ${fakeItem?.errorCode}`);
  await drainJobs();
  const closed = await getJob(carol, created.json.data.job.id);
  const usage = await usageOf(carol);
  check("a job whose files were all rejected ends as `failed`, holding nothing", closed?.state === "failed" && usage?.reservedBytes === 0 && usage.sourceBytes === 0 && usage.activeJobs === 0, `${closed?.state} ${JSON.stringify(usage && { reserved: usage.reservedBytes, source: usage.sourceBytes, active: usage.activeJobs })}`);

  // Two confirmations of the same upload at the same moment (a browser retry, or a callback next to the browser's own call).
  const dup = await newSession();
  const dupJob = await createJob(dup, [fileSpec("dup.png", data, "image/png"), fileSpec("other.png", data, "image/png")]);
  const dupItem = dupJob.json.data.job.items[0];
  await putTo((await tokenFor(dup, dupItem.id)).json.data.upload, data, { cookie: dup });
  const both = await Promise.all([completeUpload(dup, dupItem.id), completeUpload(dup, dupItem.id), completeUpload(dup, dupItem.id)]);
  const dupUsage = await usageOf(dup);
  check("simultaneous confirmations of one upload are counted once", both.every((response) => response.status === 200) && dupUsage?.sourceBytes === data.length && dupUsage.reservedBytes === data.length && dupUsage.lifetime.uploads === 1 && dupUsage.lifetime.uploadBytes === data.length, JSON.stringify(dupUsage && { source: dupUsage.sourceBytes, reserved: dupUsage.reservedBytes, uploads: dupUsage.lifetime.uploads }));
  // Removing a file before processing.
  const removed = await call(`/api/v1/uploads/${dupJob.json.data.job.items[1].id}`, { cookie: dup, method: "DELETE" });
  const afterRemove = await usageOf(dup);
  check("removing a file that was not uploaded yet releases its reservation and queues the rest of the job", removed.status === 200 && removed.json?.data?.job?.items[1].state === "cancelled" && removed.json.data.job.state === "queued" && afterRemove?.reservedBytes === 0, `${removed.status} ${removed.json?.data?.job?.state} reserved ${afterRemove?.reservedBytes}`);
  await drainJobs();
  const dupDone = await getJob(dup, dupJob.json.data.job.id);
  check("a job with a removed file completes with the remaining file", dupDone?.state === "completed" && dupDone.counts.completed === 1 && dupDone.counts.cancelled === 1, `${dupDone?.state}`);
  const lateRemove = await call(`/api/v1/uploads/${dupItem.id}`, { cookie: dup, method: "DELETE" });
  check("a file cannot be removed once the job has left the upload phase (409)", lateRemove.status === 409);

  const malformed = await Promise.all([
    call("/api/v1/uploads/token", { cookie: carol, json: { uploadId: "../../etc/passwd" } }),
    call("/api/v1/uploads/complete", { cookie: carol, json: { uploadId: "not-a-uuid" } }),
    call("/api/v1/uploads/%2e%2e%2f%2e%2e%2fsecret", { cookie: carol, method: "DELETE" }),
    call("/api/v1/jobs/..%2f..%2fadmin", { cookie: carol }),
    call("/api/v1/artifacts/..%2f..%2fetc%2fpasswd", { cookie: carol }),
  ]);
  check("malformed IDs and path tricks are answered with 4xx, never with a file or a 500", malformed.every((response) => response.status >= 400 && response.status < 500), malformed.map((response) => response.status).join(" "));
}

/* ================================================================ 4. formats */
section("image processing: formats, transparency, animation, limits, partial failure");
await resetLimits();
{
  const dana = await newSession();
  const { job } = await submit(dana, [
    fileSpec("photo.jpg", jpegSmall, "image/jpeg"),
    fileSpec("alpha.png", pngAlpha, "image/png"),
    fileSpec("moving.gif", gif, "image/gif"),
    fileSpec("source.webp", webpSource, "image/webp"),
  ], { format: "webp", quality: 80 });
  const run = await drainJobs();
  const done = await getJob(dana, job.id);
  check("a four-file batch (JPEG, PNG, GIF, WebP) is converted completely, in order", run.itemsCompleted === 4 && done?.state === "completed" && done.items.map((item) => item.filename).join() === "photo.jpg,alpha.png,moving.gif,source.webp" && done.items.every((item) => item.state === "completed" && item.result.outputFormat === "webp"), `${done?.state} ${JSON.stringify(run)}`);
  const files = await Promise.all(done.items.map((item) => download(dana, item.artifactId)));
  const metas = await Promise.all(files.map((file) => sharp(file.bytes, { animated: true }).metadata().catch(() => null)));
  check("transparency is preserved", metas[1]?.hasAlpha === true);
  check("the animated GIF keeps all its frames", (metas[2]?.pages ?? 1) === 3, `pages ${metas[2]?.pages}`);
  check("every download has exactly the reported size", files.every((file, index) => file.status === 200 && file.bytes.length === done.items[index].result.outputBytes));

  // ZIP of the four results, streamed.
  const zip = await call("/api/v1/artifacts/zip", { cookie: dana, json: { ids: done.items.map((item) => item.artifactId), name: "batch" } });
  const archive = zip.status === 200 ? await JSZip.loadAsync(zip.bytes).catch(() => null) : null;
  const names = archive ? Object.keys(archive.files).sort() : [];
  check("the ZIP download is a valid archive with the four files and a manifest", zip.status === 200 && zip.headers.get("content-type") === "application/zip" && names.join() === "alpha-optiweb.webp,moving-optiweb.webp,optiweb-manifest.txt,photo-optiweb.webp,source-optiweb.webp", `status ${zip.status}: ${names.join()}`);
  check("its Content-Length is the exact size of the archive", zip.headers.get("content-length") === String(zip.bytes.length));
  let identical = Boolean(archive);
  for (const [index, item] of done.items.entries()) {
    const entry = archive?.file(item.result.outputFilename);
    identical &&= Boolean(entry) && Buffer.from(await entry.async("uint8array")).equals(files[index].bytes);
  }
  check("every ZIP entry is byte-identical to the individual download", identical);
}
{
  // One image above the per-image pixel limit, one valid, one corrupt: the batch survives.
  const erin = await newSession();
  const huge = await sharp({ create: { width: 2000, height: 1100, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  const corrupt = Buffer.concat([jpegSmall.subarray(0, 400), Buffer.alloc(3000, 0x00)]);
  const { job } = await submit(erin, [fileSpec("huge.png", huge, "image/png"), fileSpec("ok.jpg", jpegOther, "image/jpeg"), fileSpec("corrupt.jpg", corrupt, "image/jpeg")]);
  const run = await drainJobs();
  const done = await getJob(erin, job.id);
  const [tooLarge, fine, broken] = done?.items ?? [];
  check("an image above the decoded-pixel limit fails with the limit named; it is not decoded", tooLarge?.state === "failed" && tooLarge.errorCode === "payload_too_large" && /2,000,000 pixel limit per image/.test(tooLarge.message ?? "") && tooLarge.retryable === false, `${tooLarge?.errorCode}: ${tooLarge?.message}`);
  check("a corrupt image fails as unreadable, and is not retried", broken?.state === "failed" && broken.attempts === 1 && broken.retryable === false && ["unsupported_media_type", "unprocessable_entity"].includes(broken.errorCode), `${broken?.errorCode}, attempts ${broken?.attempts}`);
  check("the valid file of the same batch is converted: the job is `partial`", fine?.state === "completed" && done.state === "partial" && done.counts.completed === 1 && done.counts.failed === 2 && run.itemsFailed === 2, `${done?.state}`);
  const refused = await call(`/api/v1/jobs/${job.id}/retry`, { cookie: erin, method: "POST" });
  check("retrying is refused when no failure was temporary (409)", refused.status === 409 && refused.json?.error?.code === "conflict", `status ${refused.status}`);
}
{
  // The per-job pixel budget (3 MP here): 1.9 MP + 1.9 MP does not fit.
  const finn = await newSession();
  const big = await sharp({ create: { width: 1900, height: 1000, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
  const { job } = await submit(finn, [fileSpec("one.png", big, "image/png"), fileSpec("two.png", big, "image/png")]);
  await drainJobs();
  const done = await getJob(finn, job.id);
  check("the per-job pixel budget stops the file that would exceed it", done?.items[0].state === "completed" && done.items[1].state === "failed" && done.items[1].errorCode === "job_pixel_budget_exceeded" && done.state === "partial", `${done?.items[1].errorCode}`);
}
{
  // An output that is larger than its source.
  const gail = await newSession();
  const compact = await sharp(jpegSmall).jpeg({ quality: 35 }).toBuffer();
  const single = await submit(gail, [fileSpec("compact.jpg", compact, "image/jpeg")], { format: "png", policy: "single" });
  await drainJobs();
  const grown = (await getJob(gail, single.job.id))?.items[0];
  check("an output larger than the source is reported as a negative saving, not hidden", grown?.state === "completed" && grown.result.outputBytes > compact.length && grown.result.savedBytes < 0 && grown.result.savingsPercent < 0, `${grown?.result?.outputBytes} vs ${compact.length}`);
  const kept = await submit(gail, [fileSpec("compact.jpg", compact, "image/jpeg")], { format: "png", policy: "no-regression", quality: 100 });
  await drainJobs();
  const retained = (await getJob(gail, kept.job.id))?.items[0];
  const original = retained ? await download(gail, retained.artifactId) : null;
  check("with the no-regression policy the output is never larger than the source", retained?.state === "completed" && retained.result.outputBytes <= compact.length && original?.bytes.length === retained.result.outputBytes, `${retained?.result?.outputBytes} vs ${compact.length}, retained ${retained?.result?.retainedOriginal}`);
}


/* ========================================================== 5. storage failures */
section("storage failures: temporary ones are retried a bounded number of times; nothing is duplicated");
await resetLimits();
/** The real storage with failures injected into chosen operations. */
function flaky(plan) {
  const calls = { write: 0, read: 0 };
  const wrapped = {
    driver: storage.driver,
    authorizeUpload: (input) => storage.authorizeUpload(input),
    head: (objectPath) => storage.head(objectPath),
    remove: (paths) => storage.remove(paths),
    receive: (...args) => storage.receive(...args),
    async read(objectPath) {
      calls.read += 1;
      if (plan.read?.(calls.read, objectPath)) throw new ObjectStorageError("storage_unavailable");
      return storage.read(objectPath);
    },
    async write(objectPath, data, options) {
      calls.write += 1;
      if (plan.write?.(calls.write, objectPath)) throw new ObjectStorageError(plan.code ?? "storage_unavailable");
      return storage.write(objectPath, data, options);
    },
  };
  return { storage: wrapped, calls };
}
{
  const hank = await newSession();
  const { job } = await submit(hank, [fileSpec("retry.jpg", jpegSmall, "image/jpeg")]);
  // The first two writes of the generated file fail, the third succeeds.
  const twice = flaky({ write: (n) => n <= 2 });
  setObjectStorageForTests(twice.storage);
  const run = await drainJobs();
  setObjectStorageForTests(undefined);
  const done = await getJob(hank, job.id);
  const artifacts = await store.artifacts.find({ jobId: job.id });
  check("two temporary failures are retried and the third attempt succeeds", done?.state === "completed" && done.items[0].attempts === 3 && run.itemsRetried === 2 && twice.calls.write === 3, `${done?.state}, attempts ${done?.items[0].attempts}, retried ${run.itemsRetried}`);
  check("the retries created one artifact record and one file, not three", artifacts.length === 1 && (await env.listObjects()).filter((object) => object.includes(job.id) && object.startsWith("out/")).length === 1);
  const usage = await usageOf(hank);
  check("quota counts the generated file once", usage?.artifactBytes === done.items[0].result.outputBytes, `${usage?.artifactBytes} vs ${done?.items[0].result.outputBytes}`);

  // Storage stays down: the file is given up on after the configured attempts, and marked retryable.
  const second = await submit(hank, [fileSpec("down.jpg", jpegOther, "image/jpeg"), fileSpec("also.jpg", jpegSmall, "image/jpeg")]);
  const down = flaky({ write: (_n, objectPath) => objectPath.includes("down-optiweb") });
  setObjectStorageForTests(down.storage);
  await drainJobs();
  setObjectStorageForTests(undefined);
  const failed = await getJob(hank, second.job.id);
  check("a failure that persists stops after 3 attempts; the other file of the batch is unaffected", failed?.state === "partial" && failed.items[0].state === "failed" && failed.items[0].attempts === 3 && failed.items[0].errorCode === "storage_unavailable" && failed.items[0].retryable === true && failed.items[1].state === "completed", `${failed?.state}, attempts ${failed?.items[0].attempts}, ${failed?.items[0].errorCode}`);
  const usageFailed = await usageOf(hank);
  check("a failed write leaves no quota reserved for the missing file", usageFailed?.artifactBytes === done.items[0].result.outputBytes + failed.items[1].result.outputBytes);

  // Manual retry, now that storage works again.
  const retry = await call(`/api/v1/jobs/${second.job.id}/retry`, { cookie: hank, method: "POST" });
  check("retrying answers 202 and puts only the failed file back in the queue", retry.status === 202 && retry.json?.data?.job?.state === "queued" && retry.json.data.job.items[0].state === "uploaded" && retry.json.data.job.items[0].attempts === 0 && retry.json.data.job.items[1].state === "completed", `status ${retry.status}`);
  const rerun = await drainJobs();
  const recovered = await getJob(hank, second.job.id);
  check("the retried file is converted and the job becomes `completed`", rerun.itemsCompleted === 1 && recovered?.state === "completed" && recovered.items.every((item) => item.state === "completed"), `${recovered?.state} ${JSON.stringify(rerun)}`);
  const again = await call(`/api/v1/jobs/${second.job.id}/retry`, { cookie: hank, method: "POST" });
  check("a job without failed files cannot be retried (409)", again.status === 409);

  // A misconfigured store is not a temporary failure: no retry loop.
  const third = await submit(hank, [fileSpec("config.jpg", jpegSmall, "image/jpeg")]);
  const denied = flaky({ write: () => true, code: "storage_misconfigured" });
  setObjectStorageForTests(denied.storage);
  await drainJobs();
  setObjectStorageForTests(undefined);
  const rejected = await getJob(hank, third.job.id);
  check("a store that rejects the credentials fails the file at once, without retries", rejected?.items[0].state === "failed" && rejected.items[0].attempts === 1 && rejected.items[0].errorCode === "storage_misconfigured" && denied.calls.write === 1, `attempts ${rejected?.items[0].attempts}, ${rejected?.items[0].errorCode}`);

  // The source object disappears before processing.
  const fourth = await submit(hank, [fileSpec("vanish.jpg", jpegSmall, "image/jpeg")]);
  const [vanishing] = await itemsOf(fourth.job.id);
  await fs.rm(path.join(env.storageDir, vanishing.path));
  await drainJobs();
  const missing = await getJob(hank, fourth.job.id);
  check("a source file that is missing from storage fails as source_missing, not retried", missing?.state === "failed" && missing.items[0].errorCode === "source_missing" && missing.items[0].attempts === 1 && missing.items[0].retryable === false, `${missing?.items[0].errorCode}`);

  // A generated file disappears from storage after the job finished.
  const [kept] = await store.artifacts.find({ jobId: job.id });
  await fs.rm(path.join(env.storageDir, kept.path));
  const gone = await download(hank, kept._id);
  check("a generated file that is missing from storage downloads as 404, not as an empty file", gone.status === 404 && gone.json?.error?.code === "not_found", `status ${gone.status}`);
}

/* ============================================================== 6. the worker */
section("the worker: one claim per job, recovery after a crash, cancellation");
await resetLimits();
{
  const ivy = await newSession();
  const { job } = await submit(ivy, [fileSpec("a.jpg", jpegSmall, "image/jpeg"), fileSpec("b.jpg", jpegOther, "image/jpeg"), fileSpec("c.png", pngAlpha, "image/png")]);
  // Two worker runs at the same moment, as two function instances would be.
  const writes = flaky({});
  setObjectStorageForTests(writes.storage);
  const [one, two] = await Promise.all([drainJobs(), drainJobs()]);
  setObjectStorageForTests(undefined);
  const done = await getJob(ivy, job.id);
  check("two concurrent worker runs: exactly one claims the job", one.claimed + two.claimed === 1 && one.finished + two.finished === 1, `${one.claimed}+${two.claimed} claimed`);
  check("each file is converted and written exactly once", done?.state === "completed" && writes.calls.write === 3 && done.items.every((item) => item.attempts === 1) && (await store.artifacts.countDocuments({ jobId: job.id })) === 3, `writes ${writes.calls.write}`);
  check("an idle worker run does nothing", (await drainJobs()).claimed === 0);
}
{
  // A worker dies in the middle of a job: it had finished the first file and was working on the second.
  const jade = await newSession();
  const { job } = await submit(jade, [fileSpec("a.jpg", jpegSmall, "image/jpeg"), fileSpec("b.jpg", jpegOther, "image/jpeg"), fileSpec("c.png", pngAlpha, "image/png")]);
  await drainJobs({ budgetMs: 1 }); // claims nothing: no time
  const interrupted = flaky({ read: (n) => n === 2 });
  // Simulate the crash: process the first file, then leave the job exactly as a killed worker leaves it.
  setObjectStorageForTests({ ...interrupted.storage, read: async (objectPath) => { if ((interrupted.calls.read += 1) === 2) throw Object.assign(new Error("process killed"), { killed: true }); return storage.read(objectPath); } });
  await drainJobs().catch(() => undefined);
  setObjectStorageForTests(undefined);
  const items = await itemsOf(job.id);
  // Whatever the run recorded for the second file, put the job in the state a crash leaves:
  // the file marked as in progress with its attempt counted, and the lease still held by the dead worker.
  await store.items.updateOne({ _id: items[1]._id }, { $set: { state: "processing", attempts: 1, errorCode: null, message: null } });
  await store.items.updateOne({ _id: items[2]._id }, { $set: { state: "uploaded", attempts: 0 } });
  await store.jobs.updateOne({ _id: job.id }, { $set: { state: "processing", status: "processing", leaseOwner: "dead-worker", leaseUntil: new Date(Date.now() + 60_000), finishedAt: null, slotReleased: false } });
  const held = await drainJobs();
  check("while the dead worker's lease is live, no other worker takes the job", held.claimed === 0 && (await getJob(jade, job.id))?.state === "processing");
  await store.jobs.updateOne({ _id: job.id }, { $set: { leaseUntil: new Date(Date.now() - 1) } });
  const resumed = await drainJobs();
  const done = await getJob(jade, job.id);
  check("once the lease lapses, the next worker run takes the job over and finishes it", resumed.claimed === 1 && resumed.finished === 1 && done?.state === "completed", `${JSON.stringify(resumed)} ${done?.state}`);
  check("the finished file is not processed again; the interrupted file counts its lost attempt", done?.items[0].attempts === 1 && done.items[1].attempts === 2 && done.items[2].attempts === 1 && resumed.itemsCompleted === 2, done?.items.map((item) => item.attempts).join(","));
  check("recovery left one artifact per file", (await store.artifacts.countDocuments({ jobId: job.id })) === 3);

  // A file that kills the worker every time is given up on, instead of looping forever.
  const poison = await submit(jade, [fileSpec("poison.jpg", jpegSmall, "image/jpeg")]);
  const [poisonItem] = await itemsOf(poison.job.id);
  await store.items.updateOne({ _id: poisonItem._id }, { $set: { state: "processing", attempts: 3 } });
  await store.jobs.updateOne({ _id: poison.job.id }, { $set: { state: "processing", status: "processing", leaseOwner: "dead-worker", leaseUntil: new Date(Date.now() - 1) } });
  await drainJobs();
  const givenUp = await getJob(jade, poison.job.id);
  check("a file that has used all its attempts is failed as retry_exhausted", givenUp?.state === "failed" && givenUp.items[0].errorCode === "retry_exhausted" && givenUp.items[0].attempts === 3, `${givenUp?.items[0].errorCode}`);
}
{
  // The time budget of a worker run: it stops between files and leaves the rest for the next run.
  const kim = await newSession();
  const { job } = await submit(kim, [fileSpec("a.jpg", jpegSmall, "image/jpeg"), fileSpec("b.jpg", jpegOther, "image/jpeg")]);
  // A file is only started when 45 seconds are left; this run has 40.
  const short = await drainJobs({ budgetMs: 40_000 });
  const paused = await getJob(kim, job.id);
  check("a run without time for another file puts the job back in the queue, unharmed", short.yielded === 1 && short.itemsCompleted === 0 && paused?.state === "queued" && paused.counts.waiting === 2, `${JSON.stringify(short)} ${paused?.state}`);
  const rest = await drainJobs();
  check("the next run completes it", rest.finished === 1 && (await getJob(kim, job.id))?.state === "completed");
}
{
  // Cancellation before processing.
  const lee = await newSession();
  const queued = await submit(lee, [fileSpec("a.jpg", jpegSmall, "image/jpeg"), fileSpec("b.jpg", jpegOther, "image/jpeg")]);
  const cancelled = await call(`/api/v1/jobs/${queued.job.id}/cancel`, { cookie: lee, method: "POST" });
  const view = cancelled.json?.data?.job;
  const usage = await usageOf(lee);
  check("a queued job is cancelled at once: files cancelled, sources deleted, quota and slot given back", cancelled.status === 200 && view?.state === "cancelled" && view.items.every((item) => item.state === "cancelled") && usage?.sourceBytes === 0 && usage.reservedBytes === 0 && usage.activeJobs === 0 && !(await env.listObjects()).some((object) => object.includes(queued.job.id)), `${view?.state} ${JSON.stringify(usage && { source: usage.sourceBytes, active: usage.activeJobs })}`);
  check("a worker run ignores the cancelled job", (await drainJobs()).claimed === 0);
  const twice = await call(`/api/v1/jobs/${queued.job.id}/cancel`, { cookie: lee, method: "POST" });
  check("cancelling again is harmless", twice.status === 200 && twice.json?.data?.job?.state === "cancelled");

  // Cancellation while uploads are still outstanding.
  const half = await createJob(lee, [fileSpec("a.jpg", jpegSmall, "image/jpeg"), fileSpec("b.jpg", jpegOther, "image/jpeg")]);
  const firstItem = half.json.data.job.items[0];
  await putTo((await tokenFor(lee, firstItem.id)).json.data.upload, jpegSmall, { cookie: lee });
  await completeUpload(lee, firstItem.id);
  const stopped = await call(`/api/v1/jobs/${half.json.data.job.id}/cancel`, { cookie: lee, method: "POST" });
  const afterStop = await usageOf(lee);
  check("a job cancelled during its uploads releases both the stored file and the outstanding reservation", stopped.json?.data?.job?.state === "cancelled" && afterStop?.sourceBytes === 0 && afterStop.reservedBytes === 0 && afterStop.activeJobs === 0, JSON.stringify(afterStop && { source: afterStop.sourceBytes, reserved: afterStop.reservedBytes }));
  const lateToken = await tokenFor(lee, half.json.data.job.items[1].id);
  check("a cancelled job accepts no further uploads (409)", lateToken.status === 409);

  // Cancellation while a worker is processing: it stops after the file in progress.
  const running = await submit(lee, [fileSpec("a.jpg", jpegSmall, "image/jpeg"), fileSpec("b.jpg", jpegOther, "image/jpeg"), fileSpec("c.png", pngAlpha, "image/png")]);
  let cancelResponse = null;
  const during = flaky({});
  setObjectStorageForTests({ ...during.storage, write: async (objectPath, data, options) => {
    // The cancel request arrives while the first file is being written.
    if ((during.calls.write += 1) === 1) cancelResponse = await call(`/api/v1/jobs/${running.job.id}/cancel`, { cookie: lee, method: "POST" });
    return storage.write(objectPath, data, options);
  } });
  await drainJobs();
  setObjectStorageForTests(undefined);
  const partial = await getJob(lee, running.job.id);
  check("the cancel request is acknowledged while the worker still holds the job", cancelResponse?.status === 200 && cancelResponse.json?.data?.job?.state === "processing" && cancelResponse.json.data.job.cancelRequested === true, `${cancelResponse?.json?.data?.job?.state}`);
  check("the worker finishes the file in progress, cancels the rest, and the job ends as `cancelled`", partial?.state === "cancelled" && partial.items[0].state === "completed" && partial.items[1].state === "cancelled" && partial.items[2].state === "cancelled" && during.calls.write === 1, partial?.items.map((item) => item.state).join(","));
  const keptFile = await download(lee, partial.items[0].artifactId);
  check("the file that was converted before the cancellation stays downloadable", keptFile.status === 200 && keptFile.bytes.length === partial.items[0].result.outputBytes);
}

/* ===================================================== 7. quotas and admission */
section("quotas: storage, active jobs and request rate are enforced atomically, across requests");
await resetLimits();
{
  const mia = await newSession();
  const twoMb = { name: "big.png", type: "image/png", size: 2 * MB };
  // 8 MB quota. Three declared jobs of 4 MB each, at the same moment: only what fits may be admitted.
  const racing = await Promise.all([0, 1, 2].map((index) => call("/api/v1/jobs/image-optimization", { cookie: mia, json: { files: [twoMb, { ...twoMb, name: `b${index}.png` }] } })));
  const admitted = racing.filter((response) => response.status === 201);
  const refused = racing.filter((response) => response.status !== 201);
  const usage = await usageOf(mia);
  check("of three simultaneous 4 MB jobs, exactly two are admitted (job slots: 2, quota: 8 MB)", admitted.length === 2 && refused.length === 1 && [403, 429].includes(refused[0].status), racing.map((response) => response.status).join(" "));
  check("the reservation equals what was admitted: 8 MB, not 12", usage?.reservedBytes === 8 * MB && usage.activeJobs === 2 && usage.remainingBytes === 0, JSON.stringify(usage && { reserved: usage.reservedBytes, active: usage.activeJobs }));

  const third = await call("/api/v1/jobs/image-optimization", { cookie: mia, json: { files: [{ name: "small.png", type: "image/png", size: 1000 }] } });
  check("a third unfinished job is refused with 429 too_many_active_jobs", third.status === 429 && third.json?.error?.code === "too_many_active_jobs", `status ${third.status} ${third.json?.error?.code}`);

  // Free a slot, keep the storage full: now the quota is what refuses.
  await call(`/api/v1/jobs/${admitted[0].json.data.job.id}/cancel`, { cookie: mia, method: "POST" });
  const afterCancel = await usageOf(mia);
  check("cancelling a job gives back its 4 MB reservation and its slot", afterCancel?.reservedBytes === 4 * MB && afterCancel.activeJobs === 1);
  const overQuota = await call("/api/v1/jobs/image-optimization", { cookie: mia, json: { files: [twoMb, { ...twoMb, name: "c.png" }, { ...twoMb, name: "d.png", size: 1024 }] } });
  check("a job that does not fit in the remaining quota is refused with 403 quota_exceeded", overQuota.status === 403 && overQuota.json?.error?.code === "quota_exceeded" && overQuota.json.error.message.includes("8 MB of storage"), `status ${overQuota.status}`);
  const stillSame = await usageOf(mia);
  check("the refused job changed nothing", stillSame?.reservedBytes === 4 * MB && stillSame.activeJobs === 1);

  // Asking for authorizations again and again must not grow the reservation.
  const remaining = admitted[1].json.data.job;
  for (let round = 0; round < 5; round += 1) await tokenFor(mia, remaining.items[0].id);
  const afterTokens = await usageOf(mia);
  check("requesting an upload authorization repeatedly reserves nothing extra", afterTokens?.reservedBytes === 4 * MB, `${afterTokens?.reservedBytes}`);
  await call(`/api/v1/jobs/${remaining.id}/cancel`, { cookie: mia, method: "POST" });
  const empty = await usageOf(mia);
  check("with every job cancelled the session holds nothing", empty?.usedBytes === 0 && empty.activeJobs === 0 && empty.remainingBytes === 8 * MB);
}
{
  // Idempotency: the same key creates one job.
  const nora = await newSession();
  const body = { files: [{ name: "once.png", type: "image/png", size: 5000 }], idempotencyKey: "selftest-key-0001" };
  const first = await call("/api/v1/jobs/image-optimization", { cookie: nora, json: body });
  const replay = await call("/api/v1/jobs/image-optimization", { cookie: nora, json: body });
  const viaHeader = await call("/api/v1/jobs/image-optimization", { cookie: nora, json: { files: body.files }, headers: { "idempotency-key": "selftest-key-0001" } });
  const usage = await usageOf(nora);
  check("a repeated request with the same idempotency key returns the same job (200), and reserves once", first.status === 201 && replay.status === 200 && replay.json?.data?.replayed === true && replay.json.data.job.id === first.json.data.job.id && viaHeader.json?.data?.job?.id === first.json.data.job.id && usage?.reservedBytes === 5000 && usage.activeJobs === 1, `${first.status} ${replay.status} reserved ${usage?.reservedBytes}`);
  const racing = await Promise.all([0, 1, 2, 3].map(() => call("/api/v1/jobs/image-optimization", { cookie: nora, json: { ...body, idempotencyKey: "selftest-key-0002" } })));
  const ids = new Set(racing.map((response) => response.json?.data?.job?.id));
  const afterRace = await usageOf(nora);
  check("four simultaneous requests with one key create one job", ids.size === 1 && racing.filter((response) => response.status === 201).length === 1 && afterRace?.activeJobs === 2 && afterRace.reservedBytes === 10_000, `${[...ids].length} jobs, statuses ${racing.map((response) => response.status).join(" ")}, active ${afterRace?.activeJobs}`);
  const otherSession = await call("/api/v1/jobs/image-optimization", { cookie: await newSession(), json: body });
  check("the same key in another session is a different job", otherSession.status === 201 && otherSession.json?.data?.job?.id !== first.json.data.job.id);
}
{
  // Request rate: counted in the database, so clearing this process's memory does not reset it.
  await resetLimits();
  const omar = await newSession();
  const statuses = [];
  for (let attempt = 0; attempt < 14; attempt += 1) {
    resetRateLimits(); // what a fresh serverless instance would have: no memory of earlier requests
    const response = await call("/api/v1/jobs/image-optimization", { cookie: omar, json: { files: [] } });
    statuses.push(response.status);
  }
  const limited = await call("/api/v1/jobs/image-optimization", { cookie: omar, json: { files: [] } });
  check("the 13th job request within a minute is refused (429), even from an instance with no memory of the first 12", statuses.slice(0, 12).every((status) => status === 422) && statuses[12] === 429 && statuses[13] === 429, statuses.join(" "));
  check("the refusal carries Retry-After", limited.status === 429 && Number(limited.headers.get("retry-after")) >= 1 && limited.json?.error?.code === "rate_limited");
  const other = await call("/api/v1/jobs/image-optimization", { cookie: await newSession(), json: { files: [] } });
  check("another session is not affected", other.status === 422);
  check("the stored rate record does not contain the session ID", !(await store.rate.find({})).some((record) => record._id.includes(sessionIdOf(omar))));
}

/* ======================================================= 8. ownership of files */
section("ownership: a session reaches its own files only");
await resetLimits();
{
  const pat = await newSession();
  const quinn = await newSession();
  const { job } = await submit(pat, [fileSpec("mine.jpg", jpegSmall, "image/jpeg")]);
  await drainJobs();
  const mine = (await getJob(pat, job.id)).items[0];
  const attempts = await Promise.all([
    download(quinn, mine.artifactId),
    call(`/api/v1/artifacts/${mine.artifactId}/status`, { cookie: quinn }),
    call("/api/v1/artifacts/zip", { cookie: quinn, json: { ids: [mine.artifactId] } }),
    call(`/api/v1/jobs/${job.id}`, { cookie: quinn }),
    call(`/api/v1/jobs/${job.id}/cancel`, { cookie: quinn, method: "POST" }),
    call(`/api/v1/jobs/${job.id}/retry`, { cookie: quinn, method: "POST" }),
    call(`/api/v1/uploads/${mine.id}`, { cookie: quinn, method: "DELETE" }),
    download(undefined, mine.artifactId),
  ]);
  check("another session is denied the artifact, its status, its ZIP, the job and its controls", attempts.every(denied) && attempts.slice(3, 7).every((response) => response.status === 404), attempts.map((response) => response.status).join(" "));
  check("none of those responses contains the file", attempts.every((response) => response.json !== null && response.bytes.length < 2000));
  if (!env.usingMongo) skipped.push("exact status (404) for another session's artifact download, status and ZIP: without MongoDB the database-stored lookup answers 503");
  const own = await download(pat, mine.artifactId);
  check("the owner still downloads it", own.status === 200 && own.bytes.length === mine.result.outputBytes);

  // A record whose path points into another session's area must not be served either.
  const [record] = await store.artifacts.find({ jobId: job.id });
  const quinnJob = await submit(quinn, [fileSpec("theirs.jpg", jpegOther, "image/jpeg")]);
  await drainJobs();
  const theirs = (await getJob(quinn, quinnJob.job.id)).items[0];
  await store.artifacts.updateOne({ _id: theirs.artifactId }, { $set: { path: record.path } });
  const crossed = await download(quinn, theirs.artifactId);
  check("a record that points at another session's storage path is not served", crossed.status === 404 && crossed.bytes.length < 2000, `status ${crossed.status}`);
  check("path ownership: only the session's own prefix is accepted, and no traversal", isOwnedPath(sessionIdOf(pat), record.path) && !isOwnedPath(sessionIdOf(quinn), record.path) && !isOwnedPath(sessionIdOf(pat), `out/${ownerKey(sessionIdOf(pat))}/../${ownerKey(sessionIdOf(quinn))}/x`) && !isOwnedPath(sessionIdOf(pat), "/etc/passwd"));
}

/* ============================================================ 9. retention */
section("retention: sources and generated files are deleted from storage on schedule; History keeps the record");
await resetLimits();
{
  const rae = await newSession();
  const { job } = await submit(rae, [fileSpec("keep.jpg", jpegSmall, "image/jpeg"), fileSpec("also.png", pngAlpha, "image/png")]);
  await drainJobs();
  const done = await getJob(rae, job.id);
  const items = await itemsOf(job.id);
  const artifacts = await store.artifacts.find({ jobId: job.id });
  const paths = { sources: items.map((item) => item.path), outputs: artifacts.map((artifact) => artifact.path) };
  const hours = (n) => new Date(Date.now() + n * 3_600_000);
  check("a finished job schedules its sources for deletion 24 hours later", items.every((item) => item.sourceStored && Math.abs(item.purgeSourceAt.getTime() - hours(24).getTime()) < 60_000));
  check("generated files are kept for 30 days", artifacts.every((artifact) => Math.abs(artifact.availableUntil.getTime() - hours(720).getTime()) < 60_000));

  const early = await runCleanup({ now: hours(23), workerBudgetMs: 1 });
  check("a cleanup run before the deadline deletes nothing", early.sourcesDeleted === 0 && early.artifactsDeleted === 0 && (await Promise.all(paths.sources.map(env.objectExists))).every(Boolean));

  const afterDay = await runCleanup({ now: hours(25), workerBudgetMs: 1 });
  const usageDay = await usageOf(rae);
  check("after 24 hours the sources are deleted from storage and their quota is given back", afterDay.sourcesDeleted >= 2 && !(await Promise.all(paths.sources.map(env.objectExists))).some(Boolean) && usageDay?.sourceBytes === 0 && usageDay.files.sources === 0 && (await itemsOf(job.id)).every((item) => item.sourceStored === false), JSON.stringify(afterDay));
  check("the generated files are untouched", (await Promise.all(paths.outputs.map(env.objectExists))).every(Boolean) && (await download(rae, done.items[0].artifactId)).status === 200 && usageDay.artifactBytes === done.totals.outputBytes);
  const repeat = await runCleanup({ now: hours(25), workerBudgetMs: 1 });
  check("running the cleanup again changes nothing and counts nothing twice", repeat.sourcesDeleted === 0 && (await usageOf(rae))?.sourceBytes === 0);

  // Deletion fails once (storage down): the record must stay, and the next run must finish the job.
  const failing = flaky({});
  let failRemove = true;
  setObjectStorageForTests({ ...failing.storage, remove: async (list) => { if (failRemove) throw new ObjectStorageError("storage_unavailable"); return storage.remove(list); } });
  const blocked = await runCleanup({ now: hours(721), workerBudgetMs: 1 });
  const stillThere = await store.artifacts.find({ jobId: job.id, deletedAt: null });
  check("when storage refuses the deletion, the records stay unchanged and the failure is counted", blocked.deleteFailures >= 2 && stillThere.length === 2 && (await Promise.all(paths.outputs.map(env.objectExists))).every(Boolean) && (await usageOf(rae))?.artifactBytes === done.totals.outputBytes, JSON.stringify(blocked));
  failRemove = false;
  const retried = await runCleanup({ now: hours(721), workerBudgetMs: 1 });
  setObjectStorageForTests(undefined);
  const usageMonth = await usageOf(rae);
  check("the next run deletes the generated files and gives their quota back", retried.artifactsDeleted >= 2 && !(await Promise.all(paths.outputs.map(env.objectExists))).some(Boolean) && usageMonth?.artifactBytes === 0 && usageMonth.usedBytes === 0, JSON.stringify(retried));

  const expired = await getJob(rae, job.id);
  check("the job record is still there, and says the files are no longer available", expired?.state === "completed" && expired.items.every((item) => item.artifactAvailable === false && item.result !== null && item.artifactId !== null), JSON.stringify(expired?.items.map((item) => item.artifactAvailable)));
  const gone = await download(rae, done.items[0].artifactId);
  const status = await call(`/api/v1/artifacts/${done.items[0].artifactId}/status`, { cookie: rae });
  check("an expired file answers 404 for download and `expired` for its status", gone.status === 404 && status.status === 200 && status.json?.data?.state === "expired", `${gone.status} ${status.json?.data?.state}`);
  const noRetry = await call(`/api/v1/jobs/${job.id}/retry`, { cookie: rae, method: "POST" });
  check("nothing can be retried once the sources are gone", noRetry.status === 409);
  const snapshot = await store.jobs.findOne({ _id: job.id });
  check("the copy of the files embedded in the job record no longer offers the expired artifacts", snapshot.items.every((item) => item.artifactId === null && item.status === "completed"));
}
{
  // Uploads that never finish.
  const sam = await newSession();
  const created = await createJob(sam, [fileSpec("a.jpg", jpegSmall, "image/jpeg"), fileSpec("b.jpg", jpegOther, "image/jpeg")]);
  const [first, second] = created.json.data.job.items;
  // The first file is uploaded but never confirmed: the browser closed right after the upload.
  await putTo((await tokenFor(sam, first.id)).json.data.upload, jpegSmall, { cookie: sam });
  const minutes = (n) => new Date(Date.now() + n * 60_000);
  const soon = await runCleanup({ now: minutes(10), workerBudgetMs: 1 });
  const recovered = await getJob(sam, created.json.data.job.id);
  check("an upload that arrived without being confirmed is found in storage and accepted by the sweep", soon.uploadsRecovered === 1 && recovered?.items[0].state === "uploaded" && recovered.items[1].state === "awaiting_upload" && recovered.state === "uploading", `${JSON.stringify(soon)} ${recovered?.items.map((item) => item.state)}`);
  const late = await runCleanup({ now: minutes(121), workerBudgetMs: 1 });
  const abandoned = await getJob(sam, created.json.data.job.id);
  const usage = await usageOf(sam);
  check("a job whose uploads did not finish within the deadline is cancelled, and gives everything back", late.jobsAbandoned === 1 && abandoned?.state === "cancelled" && usage?.usedBytes === 0 && usage.activeJobs === 0 && !(await env.listObjects()).some((object) => object.includes(created.json.data.job.id)), `${JSON.stringify(late)} ${abandoned?.state}`);
  check("its remaining upload is refused (409)", (await tokenFor(sam, second.id)).status === 409);

  // Every file confirmed by the sweep itself: the job is queued and processed without the browser.
  const lone = await createJob(sam, [fileSpec("only.jpg", jpegSmall, "image/jpeg")]);
  await putTo((await tokenFor(sam, lone.json.data.job.items[0].id)).json.data.upload, jpegSmall, { cookie: sam });
  const swept = await runCleanup({ now: minutes(10) });
  const finished = await getJob(sam, lone.json.data.job.id);
  check("a job whose last upload was never confirmed is completed by the sweep alone", swept.uploadsRecovered === 1 && swept.jobsRequeued === 1 && swept.worker?.finished === 1 && finished?.state === "completed", `${JSON.stringify({ ...swept, worker: swept.worker?.finished })} ${finished?.state}`);
}
{
  // Counters that drifted are repaired by the sweep.
  const tess = await newSession();
  const { job } = await submit(tess, [fileSpec("x.jpg", jpegSmall, "image/jpeg")]);
  await drainJobs();
  const truth = await usageOf(tess);
  await store.usage.updateOne({ _id: sessionIdOf(tess) }, { $set: { sourceBytes: 999_999_999, artifactBytes: -5, reservedBytes: 12345, activeJobs: 7 } });
  const { reconcileSession } = await import("../src/server/pipeline/usage.ts");
  await reconcileSession(sessionIdOf(tess));
  const repaired = await usageOf(tess);
  check("a session's counters are recomputed from its records", repaired?.sourceBytes === truth.sourceBytes && repaired.artifactBytes === truth.artifactBytes && repaired.reservedBytes === 0 && repaired.activeJobs === 0, JSON.stringify(repaired && { source: repaired.sourceBytes, artifact: repaired.artifactBytes, active: repaired.activeJobs }));

  // Deleting a job removes its files from storage and its usage.
  const { purgeJob } = await import("../src/server/pipeline/cleanup.ts");
  if (env.usingMongo) {
    const removed = await call(`/api/v1/history/${job.id}`, { cookie: tess, method: "DELETE" });
    check("deleting the job from History answers 200", removed.status === 200, `status ${removed.status}`);
    check("the job is gone from History", (await call(`/api/v1/history/${job.id}`, { cookie: tess })).status === 404);
  } else {
    await purgeJob(sessionIdOf(tess), job.id);
    skipped.push("deleting a background job through the History API (needs MongoDB); its storage cleanup was run directly instead");
  }
  const after = await usageOf(tess);
  check("deleting a job removes its source and generated files from storage and frees its quota", !(await env.listObjects()).some((object) => object.includes(job.id)) && after?.usedBytes === 0 && (await store.items.countDocuments({ jobId: job.id })) === 0 && (await store.artifacts.countDocuments({ jobId: job.id })) === 0, JSON.stringify(after && { used: after.usedBytes }));
}

/* ======================================================== 10. operator access */
section("operator endpoints and the inline trigger");
await resetLimits();
{
  const anonymous = await call("/api/v1/internal/cron");
  const wrong = await call("/api/v1/internal/cron", { headers: { authorization: "Bearer wrong-secret-wrong-secret-0000" } });
  const prefix = await call("/api/v1/internal/cron", { headers: { authorization: `Bearer ${CRON_SECRET.slice(0, -1)}` } });
  check("the cleanup endpoint refuses requests without the secret, or with a wrong one (401)", anonymous.status === 401 && wrong.status === 401 && prefix.status === 401, `${anonymous.status} ${wrong.status} ${prefix.status}`);
  const run = await call("/api/v1/internal/cron", { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  check("with the secret it runs and reports what it did", run.status === 200 && typeof run.json?.data?.sourcesDeleted === "number" && typeof run.json.data.artifactsDeleted === "number" && run.json.data.worker !== undefined, `status ${run.status}`);
  const admin = await call("/api/v1/internal/usage", { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  check("application-wide usage is available to operators only, with budgets and today's counters", admin.status === 200 && admin.json?.data?.storage?.budgetBytes > 0 && typeof admin.json.data.today.transforms === "number" && admin.json.data.today.transforms > 0 && (await call("/api/v1/internal/usage")).status === 401, `status ${admin.status}`);
  check("it contains no session or job identifiers", !/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}/i.test(JSON.stringify(admin.json?.data)));
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const unconfigured = await call("/api/v1/internal/cron", { headers: { authorization: "Bearer " } });
  process.env.CRON_SECRET = saved;
  check("without a configured secret the endpoint is closed (503), not open", unconfigured.status === 503, `status ${unconfigured.status}`);
}
{
  // The default trigger: confirming the last upload starts the worker by itself.
  const uma = await newSession();
  process.env.OW_JOB_TRIGGER = "inline";
  const { job, last } = await submit(uma, [fileSpec("auto.jpg", jpegSmall, "image/jpeg"), fileSpec("auto.png", pngAlpha, "image/png")]);
  const seen = new Set([last.json.data.job.state]);
  let current = last.json.data.job;
  const completedCounts = [];
  for (let poll = 0; poll < 400 && !["completed", "partial", "failed", "cancelled"].includes(current.state); poll += 1) {
    await sleep(15);
    current = await getJob(uma, job.id);
    seen.add(current.state);
    completedCounts.push(current.counts.completed);
  }
  await workerIdle();
  process.env.OW_JOB_TRIGGER = "manual";
  check("with the default trigger the job is processed without any further call", current.state === "completed" && current.counts.completed === 2, `${current.state}, seen: ${[...seen].join(" → ")}`);
  check("polling shows real completion counts that never go backwards", completedCounts.every((value, index) => index === 0 || value >= completedCounts[index - 1]) && completedCounts.at(-1) === 2);
}

/* ================================================================ 11. units */
section("building blocks");
{
  const sig = (bytes) => sniffSignature(Uint8Array.from(bytes));
  check("file signatures: JPEG, PNG, GIF, WebP, TIFF, AVIF are recognised; text, SVG, PDF and HEIC are not",
    sniffSignature(jpegSmall.subarray(0, 32)) === "jpeg" && sniffSignature(pngAlpha.subarray(0, 32)) === "png" && sniffSignature(gif.subarray(0, 32)) === "gif" && sniffSignature(webpSource.subarray(0, 32)) === "webp" &&
    sig([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4]) === "tiff" && sig([0, 0, 0, 0x1c, ...Buffer.from("ftypavif")]) === "avif" &&
    sig([...Buffer.from("<svg xmlns=")]) === null && sig([...Buffer.from("%PDF-1.7 ....")]) === null && sig([0, 0, 0, 0x18, ...Buffer.from("ftypheic")]) === null && sig([...Buffer.from("plain text here")]) === null && sig([]) === null);
  check("content type: taken from the declared type or the extension; unsupported → null", rasterContentType("a.JPG", "") === "image/jpeg" && rasterContentType("a.bin", "image/png; charset=x") === "image/png" && rasterContentType("a.svg", "image/svg+xml") === null && rasterContentType("a.exe", "application/octet-stream") === null);
  check("path segments: separators, traversal and control characters cannot survive", pathSegment("../../etc/passwd") === "_.._etc_passwd" && !pathSegment("a/b\\c").includes("/") && !pathSegment("a/b\\c").includes("\\") && pathSegment("..") === "file" && pathSegment("x\u0000y\n.png") === "xy.png" && pathSegment("") === "file", `${pathSegment("../../etc/passwd")} | ${pathSegment("..")} | ${pathSegment("x\u0000y\n.png")}`);
  check("stable IDs: same inputs → same UUID; different inputs → different; valid UUID shape", stableUuid("a", "b") === stableUuid("a", "b") && stableUuid("a", "b") !== stableUuid("ab", "") && stableUuid("a", "b") !== stableUuid("b", "a") && UUID.test(stableUuid("artifact", "x", "y")));

  const local = createLocalStorage(env.storageDir);
  const escapes = await Promise.all(["../outside.txt", "a/../../outside.txt", "/etc/passwd", "ok/\u0000/x"].map((objectPath) => local.write(objectPath, Buffer.from("x"), { contentType: "text/plain", ttlDays: 1 }).then(() => "written", (error) => error.code ?? error.name)));
  check("the local storage driver refuses every path that would leave its directory", escapes.every((outcome) => outcome === "storage_misconfigured"), escapes.join(" "));

  // The streaming ZIP writer, against an independent ZIP reader.
  const parts = [["a.txt", Buffer.from("alpha")], ["a.txt", Buffer.from("second file with the same name")], ["dir/ü.bin", Buffer.alloc(70_000, 7)], ["empty.txt", Buffer.alloc(0)]];
  const { crc32 } = await import("node:zlib");
  const entries = parts.map(([name, data]) => ({ name, bytes: data.length, crc32: crc32(data) >>> 0, modified: new Date("2026-03-04T05:06:08Z"), open: async () => new ReadableStream({ start(controller) { for (let offset = 0; offset < data.length; offset += 16_384) controller.enqueue(data.subarray(offset, offset + 16_384)); controller.close(); } }) }));
  const chunks = [];
  for await (const chunk of zipChunks(entries)) chunks.push(Buffer.from(chunk));
  const archive = Buffer.concat(chunks);
  const parsed = await JSZip.loadAsync(archive, { checkCRC32: true }).catch((error) => error);
  const names = parsed.files ? Object.keys(parsed.files) : [];
  check("the streamed ZIP is valid (CRC-checked), and its length is the predicted length", !(parsed instanceof Error) && archive.length === zipLength(entries), parsed instanceof Error ? parsed.message : `${archive.length} vs ${zipLength(entries)}`);
  check("duplicate names are kept apart, slashes in names are neutralised, UTF-8 names survive", names.join("|") === "a.txt|a-2.txt|dir_ü.bin|empty.txt", names.join("|"));
  const contents = parsed.files ? await Promise.all(names.map((name) => parsed.file(name).async("nodebuffer"))) : [];
  check("every entry has its exact bytes", contents.length === 4 && contents.every((data, index) => data.equals(parts[index][1])));
  const corrupted = entries.map((entry, index) => (index === 2 ? { ...entry, crc32: (entry.crc32 + 1) >>> 0 } : entry));
  const failure = await (async () => { for await (const chunk of zipChunks(corrupted)) void chunk; })().then(() => null, (error) => error.message);
  check("a stored file that does not match its recorded checksum aborts the archive instead of being shipped", failure === "zip entry does not match its record", String(failure));
}
{
  // Oversized ZIP (limit: 1 MB in this run).
  const vic = await newSession();
  // Noise does not compress: each PNG is about 0.75 MB, so one fits under the 1 MB limit and two do not.
  const noisy = await sharp({ create: { width: 500, height: 500, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 60 } } }).png({ compressionLevel: 0 }).toBuffer();
  const { job } = await submit(vic, [fileSpec("n1.png", noisy, "image/png"), fileSpec("n2.png", noisy, "image/png")], { format: "png" });
  await drainJobs();
  const done = await getJob(vic, job.id);
  const ids = done.items.map((item) => item.artifactId);
  const total = done.items.reduce((sum, item) => sum + item.result.outputBytes, 0);
  const tooLarge = await call("/api/v1/artifacts/zip", { cookie: vic, json: { ids } });
  check("a ZIP above the configured limit is refused with 413 before anything is read", total > MB && tooLarge.status === 413 && tooLarge.json?.error?.code === "payload_too_large", `total ${total}, status ${tooLarge.status}`);
  const single = await call("/api/v1/artifacts/zip", { cookie: vic, json: { ids: [ids[0]] } });
  check("a selection within the limit is delivered", single.status === 200 && (await JSZip.loadAsync(single.bytes).then((zip) => Object.keys(zip.files).length, () => 0)) === 2);
}

/* ================================================================ 12. leaks */
section("secrets");
{
  const sessions = everything.join("\n");
  check("no response contains a storage path", !/\b(src|out)\/[0-9a-f]{24}\//.test(sessions) && !sessions.includes(env.storageDir));
  check("no response contains the cron secret or a storage credential", !sessions.includes(CRON_SECRET) && !/vercel_blob_rw_|clientSigningToken|delegationToken/i.test(sessions));
  const logs = api.takeLogs().text;
  check("no log line contains the cron secret, a session cookie value or the storage directory", !logs.includes(CRON_SECRET) && !logs.includes(env.storageDir) && !/ow_sid=/.test(logs), logs.slice(0, 200));
}

if (skipped.length > 0) {
  console.log(`\nNot run here (${skipped.length}):`);
  for (const entry of skipped) console.log(` - ${entry}`);
}
const ok = report();
await workerIdle();
await api.close();
await env.close();
if (ok) console.log("\nAll pipeline checks passed.");
process.exit(ok ? 0 : 1);
