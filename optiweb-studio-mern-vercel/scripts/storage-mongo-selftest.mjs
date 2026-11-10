#!/usr/bin/env node
/**
 * Persistence self-test against a real MongoDB server.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27017/optiweb_test_local npm run test:storage:mongo
 *
 * It runs the real API in this process and checks every claim against the
 * database itself, through a second, independent connection:
 *
 *  - a stored job really is in the database and its files download byte for
 *    byte;
 *  - a job that the database rejects, at the job record or at an output file,
 *    leaves nothing behind and is reported as not stored with the right
 *    category;
 *  - credentials the server rejects are reported as an authentication failure;
 *  - the readiness check changes no data.
 *
 * The test alters collection validators and drops its database when it ends,
 * so it refuses to run unless the database name starts with `optiweb_ci_` or
 * `optiweb_test_`. CI runs it against a throwaway `mongo:7` container.
 */
import JSZip from "jszip";
import mongoose from "mongoose";
import sharp from "sharp";
import { UUID, createChecker, imageForm, jpegImage, startApi } from "./lib/selftest-kit.mjs";

const { check, section, report, crashed } = createChecker("storage-mongo-selftest");

const baseUri = (process.env.MONGODB_URI ?? "").trim();
const databaseName = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(baseUri)?.[1] ?? "";
if (!/^optiweb_(ci|test)_[A-Za-z0-9_]+$/.test(databaseName)) {
  // The connection string is never printed.
  crashed(new Error("Refusing to run: MONGODB_URI must name a disposable database whose name starts with optiweb_ci_ or optiweb_test_."));
  process.exit(1);
}

process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });
process.env.OW_MONGO_TIMEOUT_MS = "4000";

const api = await startApi();
const { disconnectMongo } = await import("../src/server/db/mongo.ts");
const { describeStorageFailure } = await import("../src/server/db/storageDiagnostics.ts");

// Independent connection, used only to look at what is actually stored.
const inspector = new mongoose.mongo.MongoClient(baseUri, { serverSelectionTimeoutMS: 8000 });
await inspector.connect();
const db = inspector.db(databaseName);
const jobs = db.collection("optiweb_jobs");
const artifacts = db.collection("optiweb_artifacts");
const counts = async () => ({ jobs: await jobs.countDocuments({}), artifacts: await artifacts.countDocuments({}) });
const sameCounts = (a, b) => a.jobs === b.jobs && a.artifacts === b.artifacts;
const storedBytes = (document) => Buffer.from(document.data.value());

const describes = (payload, category) => {
  const expected = describeStorageFailure(category);
  return payload?.category === category && payload?.message === expected.message && payload?.hint === expected.hint;
};

let cookie = null;
async function call(path, init = {}) {
  const response = await api.call(path, { ...init, cookie });
  cookie ??= response.sessionCookie;
  return response;
}
const optimize = (files) => call("/api/v1/images/optimize", { method: "POST", body: imageForm(files, { format: "webp", quality: 78 }) });

const first = await jpegImage(640, 400, { r: 40, g: 90, b: 200 });
const second = await jpegImage(480, 480, { r: 210, g: 70, b: 60 });

/* ------------------------------------------------------------- readiness */
section("readiness against a real server");
{
  await db.dropDatabase(); // start from an empty, disposable database
  const health = await call("/api/v1/health");
  const database = health.json?.data?.database;
  check("readiness reports ok: true, connected and ready", health.status === 200 && health.json?.data?.ok === true && database?.configured === true && database?.connected === true && database?.ready === true, JSON.stringify(database ?? null).slice(0, 200));
  check("a ready database reports a latency and no failure fields", Number.isFinite(database?.latencyMs) && database?.category === undefined && database?.error === undefined);
  const liveness = await call("/api/health");
  check("liveness reports the same state", liveness.json?.ok === true && liveness.json?.database?.ready === true);
  await call("/api/v1/health");
  const after = await counts();
  check("the readiness check leaves no documents behind", after.jobs === 0 && after.artifacts === 0, JSON.stringify(after));
  check("readiness logs nothing when the database is ready", api.takeLogs().entries.length === 0);
}

/* ------------------------------------------------------------ happy path */
section("image and artifact persistence both succeed");
let storedJobId = null;
{
  const upload = await optimize([{ name: "first.jpg", data: first, type: "image/jpeg" }, { name: "second.jpg", data: second, type: "image/jpeg" }]);
  const data = upload.json?.data;
  storedJobId = data?.jobId ?? null;
  const sessionId = (cookie ?? "").split("=")[1];
  check("both files are converted", upload.status === 200 && data?.status === "completed" && data?.results?.length === 2 && data.results.every((result) => result.status === "completed"), `status ${upload.status}`);
  check("response says stored, with a job ID", data?.persisted === true && JSON.stringify(data?.storage) === JSON.stringify({ persisted: true }) && UUID.test(storedJobId ?? ""));
  check("every result has an artifactId", data?.results?.every((result) => UUID.test(result.artifactId ?? "") && result.id === result.artifactId));
  check("a stored result does not carry its file in the response", data?.results?.every((result) => result.inlineOutput === undefined && result.inlineSkipped === undefined) === true);

  const job = await jobs.findOne({ _id: storedJobId });
  check("the job record is in the database, under this session", job?.sessionId === sessionId && job?.kind === "image.optimize" && job?.items?.length === 2, job ? "found" : "missing");
  const documents = await artifacts.find({ jobId: storedJobId }).toArray();
  check("both output files are in the database, linked to the job", documents.length === 2 && documents.every((document) => document.sessionId === sessionId));

  for (const result of data?.results ?? []) {
    const document = documents.find((candidate) => candidate._id === result.artifactId);
    const bytes = document ? storedBytes(document) : Buffer.alloc(0);
    check(`${result.filename}: stored bytes match the reported output size`, bytes.length === result.outputBytes && bytes.length > 0, `${bytes.length} stored, ${result.outputBytes} reported`);
    const download = await call(`/api/v1/artifacts/${result.artifactId}`);
    check(`${result.filename}: download returns exactly the stored bytes`, download.status === 200 && download.bytes.length > 0 && download.bytes.equals(bytes), `status ${download.status}, ${download.bytes.length} bytes`);
    const metadata = await sharp(download.bytes).metadata().catch(() => null);
    check(`${result.filename}: the download decodes as the reported format and size`, metadata?.format === result.outputFormat && metadata?.width === result.outputWidth && metadata?.height === result.outputHeight, `${metadata?.format} ${metadata?.width}x${metadata?.height}`);
  }

  const zip = await call("/api/v1/artifacts/zip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: data?.results?.map((result) => result.artifactId) ?? [] }) });
  const archive = zip.status === 200 ? await JSZip.loadAsync(zip.bytes) : null;
  const zipMatches = [];
  for (const result of data?.results ?? []) {
    const entry = archive?.file(result.outputFilename);
    const document = documents.find((candidate) => candidate._id === result.artifactId);
    zipMatches.push(Boolean(entry && document) && Buffer.from(await entry.async("uint8array")).equals(storedBytes(document)));
  }
  check("the ZIP download contains both files, byte for byte", zipMatches.length === 2 && zipMatches.every(Boolean), `status ${zip.status}`);

  const history = await call("/api/v1/history?page=1&pageSize=5");
  const entry = history.json?.data?.entries?.find((candidate) => candidate.id === storedJobId);
  check("History lists the job with its files", history.status === 200 && entry?.fileCount === 2 && entry?.artifactIds?.length === 2);
  const detail = await call(`/api/v1/history/${storedJobId}`);
  check("the job detail reports a stored file for every item", detail.status === 200 && detail.json?.data?.items?.length === 2 && detail.json.data.items.every((item) => item.hasArtifact === true));
  const stranger = await api.call(`/api/v1/artifacts/${data?.results?.[0]?.artifactId}`, { cookie: "ow_sid=00000000-0000-4000-8000-000000000000" });
  check("another session cannot download the file", stranger.status === 404, `status ${stranger.status}`);
  check("nothing is logged for a successful run", api.takeLogs().entries.length === 0);
}

section("partly converted batch: the converted file is stored, the rejected one has no download");
{
  const upload = await optimize([{ name: "good.jpg", data: first, type: "image/jpeg" }, { name: "broken.png", data: Buffer.from("this is not an image"), type: "image/png" }]);
  const data = upload.json?.data;
  const good = data?.results?.find((result) => result.filename === "good.jpg");
  const broken = data?.results?.find((result) => result.filename === "broken.png");
  check("status is partial and the job is stored", upload.status === 200 && data?.status === "partial" && data?.persisted === true && UUID.test(data?.jobId ?? ""), `${upload.status} ${data?.status}`);
  check("only the converted file has an artifactId", UUID.test(good?.artifactId ?? "") && broken?.status === "failed" && broken?.artifactId === null);
  check("exactly one file is stored for the job", (await artifacts.countDocuments({ jobId: data?.jobId })) === 1);
  api.takeLogs();
}

/* ---------------------------------------------------- job write rejected */
section("the database rejects the job record → write_failed, nothing stored");
{
  await db.command({ collMod: "optiweb_jobs", validator: { $jsonSchema: { required: ["__selftest_never_present__"] } }, validationLevel: "strict", validationAction: "error" });
  const before = await counts();
  const upload = await optimize([{ name: "rejected-job.jpg", data: first, type: "image/jpeg" }]);
  const data = upload.json?.data;
  const logs = api.takeLogs();
  const entry = logs.entries.find((candidate) => candidate.operation === "job.persist:image.optimize");
  check("the image is still converted", upload.status === 200 && data?.status === "completed" && data?.results?.[0]?.outputBytes > 0, `status ${upload.status}`);
  check("response says not stored, with write_failed", data?.persisted === false && describes(data?.storage, "write_failed"), String(data?.storage?.category));
  check("response names no job and no downloadable file", data?.jobId === "" && data?.results?.every((result) => result.artifactId === null));
  const sentBack = data?.results?.[0]?.inlineOutput?.encoding === "base64" ? Buffer.from(data.results[0].inlineOutput.data, "base64") : null;
  const sentBackFormat = sentBack ? await sharp(sentBack).metadata().then((meta) => meta.format, () => null) : null;
  check("the converted file comes back in the response instead, intact", sentBack !== null && sentBack.length === data?.results?.[0]?.outputBytes && sentBackFormat === data?.results?.[0]?.outputFormat, `${sentBack?.length} bytes, ${sentBackFormat}`);
  check("log line: write_failed at stage write, document validation, rollback completed", entry?.category === "write_failed" && entry?.stage === "write" && entry?.detail === "document_validation_failed" && entry?.rollback === "completed" && entry?.requestId === upload.json?.meta?.requestId, JSON.stringify(entry ?? null).slice(0, 300));
  check("the database holds no new job and no new file", sameCounts(before, await counts()) && (await artifacts.countDocuments({ itemFilename: "rejected-job.jpg" })) === 0);
  check("the response and log do not contain the server's error text", !upload.visible.includes("Document failed validation") && !logs.text.includes("Document failed validation"));
  await db.command({ collMod: "optiweb_jobs", validator: {}, validationLevel: "off" });
}

/* ------------------------------------------- artifact insertion rejected */
section("the database rejects the second output file → artifact_insert_failed, job and first file rolled back");
{
  await db.command({ collMod: "optiweb_artifacts", validator: { itemFilename: { $ne: "rollback-second.jpg" } }, validationLevel: "strict", validationAction: "error" });

  // Control: with this validator an ordered insert keeps the first document.
  // That is the partial state the application has to remove.
  const control = await artifacts
    .insertMany([{ _id: "control-first", itemFilename: "control-first.jpg" }, { _id: "control-second", itemFilename: "rollback-second.jpg" }], { ordered: true })
    .then(() => null, (error) => error);
  check("control: an ordered insert under this validator leaves the first document behind", control?.code === 121 && (await artifacts.countDocuments({ _id: "control-first" })) === 1 && (await artifacts.countDocuments({ _id: "control-second" })) === 0, `code ${control?.code}`);
  await artifacts.deleteOne({ _id: "control-first" });

  const before = await counts();
  const historyBefore = await call("/api/v1/history");
  const upload = await optimize([{ name: "rollback-first.jpg", data: first, type: "image/jpeg" }, { name: "rollback-second.jpg", data: second, type: "image/jpeg" }]);
  const data = upload.json?.data;
  const logs = api.takeLogs();
  const entry = logs.entries.find((candidate) => candidate.operation === "job.persist:image.optimize");
  check("both images are still converted", upload.status === 200 && data?.status === "completed" && data?.results?.length === 2, `status ${upload.status}`);
  check("response says not stored, with artifact_insert_failed", data?.persisted === false && describes(data?.storage, "artifact_insert_failed"), String(data?.storage?.category));
  check("response names no job and no downloadable file", data?.jobId === "" && data?.results?.every((result) => result.artifactId === null));
  const returned = (data?.results ?? []).map((result) => (result.inlineOutput?.encoding === "base64" ? Buffer.from(result.inlineOutput.data, "base64") : null));
  check("both converted files come back in the response after the rollback", returned.length === 2 && returned.every((file, index) => file !== null && file.length === data.results[index].outputBytes), returned.map((file) => file?.length).join(", "));
  check("log line: artifact_insert_failed at stage artifact_insert, rollback completed", entry?.category === "artifact_insert_failed" && entry?.stage === "artifact_insert" && entry?.rollback === "completed" && entry?.requestId === upload.json?.meta?.requestId, JSON.stringify(entry ?? null).slice(0, 300));
  check("no rollback failure is logged", !logs.entries.some((candidate) => candidate.event === "storage_rollback_failed"));
  check("the job record is gone", (await jobs.countDocuments({ "items.filename": "rollback-first.jpg" })) === 0);
  check("the first file, which the database had accepted, is gone too", (await artifacts.countDocuments({ itemFilename: { $in: ["rollback-first.jpg", "rollback-second.jpg"] } })) === 0);
  check("the database holds exactly what it held before", sameCounts(before, await counts()), `${JSON.stringify(before)} → ${JSON.stringify(await counts())}`);
  const historyAfter = await call("/api/v1/history");
  check("History does not list the failed run", historyAfter.status === 200 && historyAfter.json?.data?.total === historyBefore.json?.data?.total && !JSON.stringify(historyAfter.json?.data?.entries ?? []).includes("rollback-first"));
  await db.command({ collMod: "optiweb_artifacts", validator: {}, validationLevel: "off" });
}

/* ------------------------------------------------------ wrong credentials */
section("the server rejects the credentials → authentication_failed");
{
  const user = "selftest-user-7f3a";
  const password = "selftest-pass-91c2Zq";
  await disconnectMongo();
  process.env.MONGODB_URI = baseUri.replace(/^(mongodb(?:\+srv)?:\/\/)/, `$1${user}:${password}@`);
  api.takeLogs();
  const health = await call("/api/v1/health");
  const database = health.json?.data?.database;
  check("readiness reports authentication_failed and is not ready", health.status === 200 && health.json?.data?.ok === false && database?.connected === false && database?.ready === false && database?.category === "authentication_failed", `reported ${database?.category}`);
  const upload = await optimize([{ name: "unauthenticated.jpg", data: first, type: "image/jpeg" }]);
  check("an upload is converted but not stored, with authentication_failed", upload.json?.data?.status === "completed" && upload.json?.data?.persisted === false && describes(upload.json?.data?.storage, "authentication_failed"), String(upload.json?.data?.storage?.category));
  const history = await call("/api/v1/history");
  check("History answers 503 with authentication_failed", history.status === 503 && history.json?.error?.code === "storage_unavailable" && history.json?.error?.details?.category === "authentication_failed", `status ${history.status}`);
  const logs = api.takeLogs();
  check("every log line has the category and a request ID", logs.entries.length >= 3 && logs.entries.every((entry) => entry.category === "authentication_failed" && UUID.test(entry.requestId ?? "")), `${logs.entries.length} lines`);
  const everything = [health.visible, upload.visible, history.visible, logs.text].join("\n");
  check("no response or log line contains the user name, password or connection string", !everything.includes(user) && !everything.includes(password) && !/mongodb(\+srv)?:\/\/[A-Za-z0-9%_[-]/.test(everything));
  await disconnectMongo();
  process.env.MONGODB_URI = baseUri;
}

/* ---------------------------------------------------------------- recovery */
section("after the failures: storage works again and earlier data is intact");
{
  const health = await call("/api/v1/health");
  check("readiness is true again", health.json?.data?.ok === true && health.json?.data?.database?.ready === true, String(health.json?.data?.database?.category));
  const upload = await optimize([{ name: "after.jpg", data: second, type: "image/jpeg" }]);
  const data = upload.json?.data;
  check("a new upload is stored", data?.persisted === true && UUID.test(data?.jobId ?? "") && (await artifacts.countDocuments({ jobId: data?.jobId })) === 1);
  const download = await call(`/api/v1/artifacts/${data?.results?.[0]?.artifactId}`);
  check("and its file downloads", download.status === 200 && download.bytes.length === data?.results?.[0]?.outputBytes, `status ${download.status}`);
  check("the job stored at the start is still complete", (await jobs.countDocuments({ _id: storedJobId })) === 1 && (await artifacts.countDocuments({ jobId: storedJobId })) === 2);
  const removed = await call(`/api/v1/history/${storedJobId}`, { method: "DELETE" });
  check("deleting a job removes its record and its files", removed.status === 200 && (await jobs.countDocuments({ _id: storedJobId })) === 0 && (await artifacts.countDocuments({ jobId: storedJobId })) === 0, `status ${removed.status}`);
  check("nothing was logged", api.takeLogs().entries.length === 0);
}

/* ----------------------------------------------------------------- summary */
await disconnectMongo();
await db.dropDatabase();
await inspector.close();
await api.close();
const ok = report();
if (ok) console.log("\nAll persistence checks passed against a real MongoDB server.");
process.exit(ok ? 0 : 1);
