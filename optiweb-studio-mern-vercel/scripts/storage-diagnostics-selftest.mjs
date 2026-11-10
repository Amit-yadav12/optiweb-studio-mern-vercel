#!/usr/bin/env node
/**
 * Storage diagnostics self-test. Needs no database.
 *
 *   npm run test:storage
 *
 * It runs the real API in this process and makes MongoDB fail in each way the
 * diagnostics are meant to tell apart, then checks three things every time:
 *
 *  1. the health endpoint and the failing request report the expected category;
 *  2. the server log has one structured line with that category and the same
 *     request ID the client received;
 *  3. no response and no log line contains the connection string, its user
 *     name, password or host, or the text of a database error.
 *
 * Connection failures are produced with real sockets on this machine (a closed
 * port, a listener that hangs up, a listener that never answers). Failures that
 * need a server reply (rejected credentials, rejected writes) are produced by a
 * scripted stand-in; see scripts/lib/scripted-mongo-server.mjs. The stand-in
 * stores nothing, so this test says nothing about whether persistence works.
 * That is covered by scripts/storage-mongo-selftest.mjs against real MongoDB.
 */
import crypto from "node:crypto";
import net from "node:net";
import mongoose from "mongoose";
import sharp from "sharp";
import { UUID, createChecker, imageForm, pngImage, startApi } from "./lib/selftest-kit.mjs";
import { serverErrors, startScriptedMongoServer } from "./lib/scripted-mongo-server.mjs";

if (process.env.MONGODB_URI || process.env.MONGO_URL) {
  throw new Error("Refusing to run: this test sets its own connection strings. Unset MONGODB_URI and MONGO_URL first.");
}

// Keep the suite fast: every connection failure waits for this timeout.
process.env.OW_MONGO_TIMEOUT_MS = "400";

const { check, section, report, crashed } = createChecker("storage-diagnostics-selftest");
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

const api = await startApi();
const { disconnectMongo } = await import("../src/server/db/mongo.ts");
const { STORAGE_FAILURE_CATEGORIES, describeStorageFailure } = await import("../src/server/db/storageDiagnostics.ts");
const { planInlineOutputs } = await import("../src/server/services/inlineOutput.ts");
const { resetRateLimits } = await import("../src/server/middleware/rateLimit.ts");
const { limits } = await import("../src/server/config/env.ts");

/* ------------------------------------------------------------------ fixtures */

// Recognisable values that must never show up in a response or a log line.
const USER = "selftest-user-7f3a";
const PASSWORD = "selftest-pass-91c2Zq";
const CREDENTIALS = `${USER}:${PASSWORD}`;
const UNRESOLVABLE_HOST = "db.optiweb-selftest.invalid";

/** Text of the scripted server errors. A raw database exception would contain one of these. */
const RAW_DATABASE_TEXT = [
  "Authentication failed",
  "bad auth",
  "Document failed validation",
  "Out of disk space",
  "over your space quota",
  "not authorized on",
  "Executor error",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "getaddrinfo",
  "Server selection timed out",
  "MongoServerError",
  "MongoNetworkError",
];
const URI_TEXT = [USER, PASSWORD, UNRESOLVABLE_HOST];
/** A connection string, as opposed to the bare scheme names that the invalid_uri hint mentions. */
const CONNECTION_STRING = /mongodb(\+srv)?:\/\/[A-Za-z0-9%_[-]/;

const listen = (onConnection) =>
  new Promise((resolve) => {
    const server = net.createServer(onConnection);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

/** A port that was free a moment ago and has no listener. */
async function closedPort() {
  const server = await listen(() => undefined);
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const hangsUp = await listen((socket) => socket.destroy());
const neverAnswers = await listen((socket) => socket.on("error", () => undefined));
const refusedPort = await closedPort();

const image = await pngImage(48, 32, { r: 36, g: 92, b: 230 });
const secondImage = await pngImage(40, 40, { r: 220, g: 60, b: 90 });
const optimize = (files = [{ name: "first.png", data: image }], init = {}) =>
  api.call("/api/v1/images/optimize", { method: "POST", body: imageForm(files, { format: "webp" }), ...init });

async function useUri(uri) {
  await disconnectMongo();
  if (uri === undefined) delete process.env.MONGODB_URI;
  else process.env.MONGODB_URI = uri;
  api.takeLogs();
}

/** Everything a client could read, plus everything the server logged, must be free of secrets and raw errors. */
function checkNothingLeaked(label, responses, logText, extraForbidden = []) {
  const clientText = responses.map((response) => response.visible).join("\n");
  const forbiddenInResponses = [...URI_TEXT, ...RAW_DATABASE_TEXT, ...extraForbidden];
  const inResponses = forbiddenInResponses.filter((needle) => clientText.includes(needle));
  check(
    `${label}: responses contain no credentials, host, connection string or raw database error`,
    inResponses.length === 0 && !CONNECTION_STRING.test(clientText),
    `found ${inResponses.length} forbidden value(s)`,
  );
  // Error class names and codes are deliberate log fields. The connection string and error messages are not.
  const forbiddenInLogs = [...URI_TEXT, ...extraForbidden, "Authentication failed", "bad auth", "Document failed validation", "Out of disk space", "over your space quota", "not authorized on", "Executor error", "getaddrinfo", "Server selection timed out"];
  const inLogs = forbiddenInLogs.filter((needle) => logText.includes(needle));
  check(
    `${label}: server log contains no credentials, host, connection string or error message`,
    inLogs.length === 0 && !CONNECTION_STRING.test(logText),
    `found ${inLogs.length} forbidden value(s)`,
  );
}

const describes = (payload, category) => {
  const expected = describeStorageFailure(category);
  return payload?.category === category && payload?.message === expected.message && payload?.hint === expected.hint;
};

/* ------------------------------------------------- 1. connection failures */

const connectionFailures = [
  { name: "MONGODB_URI is not set", uri: undefined, category: "not_configured", configured: false },
  { name: "MONGODB_URI is blank", uri: "   ", category: "not_configured", configured: false },
  { name: "MONGODB_URI is not a MongoDB connection string", uri: `https://${CREDENTIALS}@${UNRESOLVABLE_HOST}/app`, category: "invalid_uri" },
  { name: "the host name does not resolve", uri: `mongodb://${CREDENTIALS}@${UNRESOLVABLE_HOST}:27017/app`, category: "dns_failure" },
  { name: "nothing listens at the address", uri: `mongodb://${CREDENTIALS}@127.0.0.1:${refusedPort}/app`, category: "connection_refused", host: `127.0.0.1:${refusedPort}` },
  { name: "the server hangs up, as an IP access list does", uri: `mongodb://${CREDENTIALS}@127.0.0.1:${hangsUp.address().port}/app`, category: "network_access_denied", host: `127.0.0.1:${hangsUp.address().port}` },
  { name: "the server hangs up during the TLS handshake", uri: `mongodb://${CREDENTIALS}@127.0.0.1:${hangsUp.address().port}/app?tls=true`, category: "network_access_denied", host: `127.0.0.1:${hangsUp.address().port}` },
  { name: "the server never answers", uri: `mongodb://${CREDENTIALS}@127.0.0.1:${neverAnswers.address().port}/app`, category: "server_selection_timeout", host: `127.0.0.1:${neverAnswers.address().port}` },
];

for (const scenario of connectionFailures) {
  section(`${scenario.name} → ${scenario.category}`);
  await useUri(scenario.uri);
  const responses = [];
  const configured = scenario.configured ?? true;

  const health = await api.call("/api/v1/health");
  responses.push(health);
  const database = health.json?.data?.database;
  check("readiness answers HTTP 200 with ok: false", health.status === 200 && health.json?.ok === true && health.json?.data?.ok === false, `status ${health.status}`);
  check(
    "readiness reports configured, connected and ready",
    database?.configured === configured && database?.connected === false && database?.ready === false && database?.latencyMs === null,
    JSON.stringify({ configured: database?.configured, connected: database?.connected, ready: database?.ready }),
  );
  check("readiness reports the category with its fixed message and hint", database?.category === scenario.category && database?.error === describeStorageFailure(scenario.category).message && database?.hint === describeStorageFailure(scenario.category).hint, String(database?.category));
  const healthLogs = api.takeLogs();
  const healthEntry = healthLogs.entries.find((entry) => entry.operation === "health.probe");
  check("readiness failure is logged with the category", healthEntry?.event === "storage_failure" && healthEntry?.category === scenario.category && healthEntry?.level === "error", String(healthEntry?.category));
  check(
    "log line, X-Request-Id header and meta.requestId are the same ID",
    UUID.test(healthEntry?.requestId ?? "") && healthEntry?.requestId === health.headers.get("x-request-id") && healthEntry?.requestId === health.json?.meta?.requestId,
  );

  const liveness = await api.call("/api/health");
  responses.push(liveness);
  check("liveness stays ok and reports the same category", liveness.status === 200 && liveness.json?.ok === true && liveness.json?.database?.category === scenario.category && liveness.json?.database?.ready === false);

  const upload = await optimize();
  responses.push(upload);
  const data = upload.json?.data;
  check("image conversion still succeeds", upload.status === 200 && data?.status === "completed" && data?.results?.[0]?.status === "completed" && data?.results?.[0]?.outputBytes > 0, `status ${upload.status}`);
  check("response says the result was not stored, with the category", data?.persisted === false && data?.storage?.persisted === false && describes(data?.storage, scenario.category), String(data?.storage?.category));
  check("response names no job and no downloadable file", data?.jobId === "" && data?.results?.every((result) => result.artifactId === null));
  const uploadLogs = api.takeLogs();
  const uploadEntry = uploadLogs.entries.find((entry) => entry.operation === "job.persist:image.optimize");
  check("persistence failure is logged with category, stage and rollback state", uploadEntry?.category === scenario.category && uploadEntry?.stage === "connect" && uploadEntry?.rollback === "not_needed", JSON.stringify({ category: uploadEntry?.category, stage: uploadEntry?.stage, rollback: uploadEntry?.rollback }));
  check("persistence log line carries the request ID of the upload", uploadEntry?.requestId === upload.json?.meta?.requestId && uploadEntry?.requestId === upload.headers.get("x-request-id"));

  const history = await api.call("/api/v1/history");
  responses.push(history);
  check("history answers 503 storage_unavailable with the category", history.status === 503 && history.json?.error?.code === "storage_unavailable" && history.json?.error?.details?.category === scenario.category && history.json?.error?.message === describeStorageFailure(scenario.category).message && history.json?.error?.hint === describeStorageFailure(scenario.category).hint, `status ${history.status} ${history.json?.error?.details?.category}`);
  const historyLogs = api.takeLogs();
  const historyEntries = historyLogs.entries.filter((entry) => entry.operation.startsWith("history."));
  check("history failure is logged with the request ID", historyEntries.length > 0 && historyEntries.every((entry) => entry.category === scenario.category && entry.requestId === history.json?.meta?.requestId));

  checkNothingLeaked(scenario.name, responses, [healthLogs.text, uploadLogs.text, historyLogs.text].join("\n"), scenario.host ? [scenario.host] : []);
}

section("every storage-backed endpoint reports the failure (nothing listens at the address)");
await useUri(`mongodb://${CREDENTIALS}@127.0.0.1:${refusedPort}/app`);
{
  const someId = "3f2b8c1e-5a47-4d1b-9c3e-7a1f0b2d4e6f";
  const json = { "content-type": "application/json" };
  const unavailable = [
    ["GET /api/v1/history/:id", await api.call(`/api/v1/history/${someId}`), "history.detail"],
    ["DELETE /api/v1/history/:id", await api.call(`/api/v1/history/${someId}`, { method: "DELETE" }), "history.delete"],
    ["DELETE /api/v1/history", await api.call("/api/v1/history", { method: "DELETE" }), "history.clear"],
    ["GET /api/v1/artifacts/:id", await api.call(`/api/v1/artifacts/${someId}`), "artifact.read"],
    ["POST /api/v1/artifacts/zip", await api.call("/api/v1/artifacts/zip", { method: "POST", headers: json, body: JSON.stringify({ ids: [someId] }) }), "artifact.read_many"],
    ["PUT /api/v1/preferences", await api.call("/api/v1/preferences", { method: "PUT", headers: json, body: JSON.stringify({ defaultImageFormat: "webp", defaultQuality: 80, defaultMaxWidth: null, fontDisplayPolicy: "swap", analyzerThresholdKb: 300, reduceMotion: false }) }), "preferences.save"],
  ];
  const logs = api.takeLogs();
  for (const [name, response, operation] of unavailable) {
    const entry = logs.entries.find((candidate) => candidate.operation === operation);
    check(`${name} answers 503 with the category and logs ${operation}`, response.status === 503 && response.json?.error?.details?.category === "connection_refused" && entry?.category === "connection_refused" && entry?.requestId === response.json?.meta?.requestId, `status ${response.status}, logged ${entry?.category}`);
  }
  const preferences = await api.call("/api/v1/preferences");
  const preferenceLogs = api.takeLogs();
  check("GET /api/v1/preferences falls back to defaults and still logs the failure", preferences.status === 200 && preferences.json?.data?.updatedAt === null && preferenceLogs.entries.some((entry) => entry.operation === "preferences.read" && entry.category === "connection_refused" && entry.requestId === preferences.json?.meta?.requestId));

  const css = await api.call("/api/v1/css/patch-font-display", { method: "POST", headers: json, body: JSON.stringify({ css: "@font-face { font-family: Demo; src: url(demo.woff2); }", policy: "swap" }) });
  check("CSS patch reports not stored with the category and no artifact", css.status === 200 && css.json?.data?.persisted === false && css.json?.data?.artifactId === null && css.json?.data?.jobId === "" && describes(css.json?.data?.storage, "connection_refused"));
  const analysis = await api.call("/api/v1/assets/analyze", { method: "POST", body: imageForm([{ name: "first.png", data: image }]) });
  check("asset analysis reports not stored with the category", analysis.status === 200 && analysis.json?.data?.persisted === false && analysis.json?.data?.jobId === "" && describes(analysis.json?.data?.storage, "connection_refused"));
  const moreLogs = api.takeLogs();
  check("each tool logs under its own operation name", moreLogs.entries.some((entry) => entry.operation === "job.persist:css.font-display") && moreLogs.entries.some((entry) => entry.operation === "job.persist:asset.analyze"));
  checkNothingLeaked("all endpoints", [...unavailable.map((row) => row[1]), preferences, css, analysis], [logs.text, preferenceLogs.text, moreLogs.text].join("\n"), [`127.0.0.1:${refusedPort}`]);
}

section("request IDs");
{
  const supplied = await api.call("/api/v1/health", { headers: { "x-request-id": "selftest-request-0001" } });
  const logs = api.takeLogs();
  check("a valid client-supplied X-Request-Id is used in header, body and log", supplied.headers.get("x-request-id") === "selftest-request-0001" && supplied.json?.meta?.requestId === "selftest-request-0001" && logs.entries[0]?.requestId === "selftest-request-0001");
  const unsafe = await api.call("/api/v1/health", { headers: { "x-request-id": "bad id\twith \"quotes\"" } });
  const unsafeLogs = api.takeLogs();
  check("an unsafe client-supplied X-Request-Id is replaced, not logged", UUID.test(unsafe.headers.get("x-request-id") ?? "") && unsafeLogs.entries[0]?.requestId === unsafe.headers.get("x-request-id") && !unsafeLogs.text.includes("bad id"));
  const [first, second] = await Promise.all([
    optimize(undefined, { headers: { "x-request-id": "selftest-parallel-aaaa" } }),
    optimize(undefined, { headers: { "x-request-id": "selftest-parallel-bbbb" } }),
  ]);
  const parallel = api.takeLogs().entries.filter((entry) => entry.operation === "job.persist:image.optimize").map((entry) => entry.requestId).sort();
  check("concurrent requests are logged under their own IDs", first.json?.meta?.requestId === "selftest-parallel-aaaa" && second.json?.meta?.requestId === "selftest-parallel-bbbb" && parallel.join() === "selftest-parallel-aaaa,selftest-parallel-bbbb", parallel.join());
}

/* ------------------------------------------ 2. failures that need a reply */

const standIn = await startScriptedMongoServer();
const jobInserts = () => standIn.received("insert", "optiweb_jobs");
const deletesFor = (collection) => standIn.received("delete", collection).flatMap((entry) => entry.command.deletes ?? []);
const nonProbeDeletes = (collection) => deletesFor(collection).filter((entry) => entry.q?._id !== "__optiweb_readiness_probe__");
const isCollection = (name) => (command, context) => command === "insert" && context.collection === name;
async function useStandIn(script, credentials = "") {
  await useUri(standIn.uri("optiweb_selftest", credentials));
  standIn.setScript(script);
  standIn.clear();
}

section("the server rejects the credentials → authentication_failed");
for (const [label, reply] of [["standard error (code 18)", serverErrors.authenticationFailed], ["Atlas error (code 8000)", serverErrors.atlasBadAuth]]) {
  await useStandIn((name) => (name === "saslStart" ? reply : undefined), CREDENTIALS);
  const health = await api.call("/api/v1/health");
  const upload = await optimize();
  const history = await api.call("/api/v1/history");
  const logs = api.takeLogs();
  check(`${label}: readiness reports authentication_failed`, health.json?.data?.ok === false && health.json?.data?.database?.connected === false && describes({ ...health.json?.data?.database, message: health.json?.data?.database?.error }, "authentication_failed"));
  check(`${label}: upload is converted but not stored, with the category`, upload.json?.data?.status === "completed" && upload.json?.data?.persisted === false && describes(upload.json?.data?.storage, "authentication_failed"));
  check(`${label}: history answers 503 with the category`, history.status === 503 && history.json?.error?.details?.category === "authentication_failed");
  check(`${label}: every log line has the category and a request ID`, logs.entries.length >= 3 && logs.entries.every((entry) => entry.category === "authentication_failed" && UUID.test(entry.requestId ?? "")), String(logs.entries.length));
  checkNothingLeaked(label, [health, upload, history], logs.text, [`127.0.0.1:${standIn.port}`]);
}

section("a reachable server that accepts reads and writes → ready");
await useStandIn(undefined);
{
  const health = await api.call("/api/v1/health");
  const database = health.json?.data?.database;
  check("readiness reports ok: true, connected and ready with a latency", health.json?.data?.ok === true && database?.configured === true && database?.connected === true && database?.ready === true && Number.isFinite(database?.latencyMs));
  check("a ready database has no category, error or hint", !("category" in (database ?? {})) && !("error" in (database ?? {})) && !("hint" in (database ?? {})));
  check("readiness logs nothing when the database is ready", api.takeLogs().entries.length === 0);
  const probeCommands = standIn.commands.filter((entry) => ["insert", "update", "findAndModify", "delete", "drop", "dropDatabase"].includes(entry.name));
  const probeDeletes = deletesFor("optiweb_jobs");
  check(
    "the only write command the check sends is a delete that can match nothing",
    probeCommands.length === 1 && probeCommands[0].name === "delete" && probeDeletes.length === 1 && probeDeletes[0].q?._id === "__optiweb_readiness_probe__" && Object.keys(probeDeletes[0].q).length === 1,
    probeCommands.map((entry) => entry.name).join(","),
  );
  check("the check reads the job collection", standIn.received("find", "optiweb_jobs").length === 1 && standIn.received("ping").length >= 1);

  // A value pasted from a .env file often keeps its quotes and a trailing space.
  await useUri(`"${standIn.uri("optiweb_selftest")}" `);
  const quoted = await api.call("/api/v1/health");
  check("a connection string wrapped in quotes, with a trailing space, still connects", quoted.json?.data?.database?.ready === true, String(quoted.json?.data?.database?.category));
  await useUri(` '${standIn.uri("optiweb_selftest")}'\n`);
  const singleQuoted = await api.call("/api/v1/health");
  check("single quotes and a trailing newline are handled the same way", singleQuoted.json?.data?.database?.ready === true, String(singleQuoted.json?.data?.database?.category));
}

section("a read-only database user → readiness is false, not just a failed upload");
await useStandIn((name) => (["insert", "update", "delete", "findAndModify", "create", "createIndexes"].includes(name) ? serverErrors.unauthorized(name) : undefined));
{
  const health = await api.call("/api/v1/health");
  const database = health.json?.data?.database;
  const logs = api.takeLogs();
  check("readiness reports connected: true, ready: false, permission_denied", health.json?.data?.ok === false && database?.connected === true && database?.ready === false && database?.category === "permission_denied" && database?.hint === describeStorageFailure("permission_denied").hint);
  check("the log line names the write step of the check", logs.entries.some((entry) => entry.operation === "health.probe" && entry.stage === "write" && entry.category === "permission_denied" && entry.errorCode === "13"));
  const upload = await optimize();
  check("an upload is converted but not stored, with permission_denied", upload.json?.data?.persisted === false && describes(upload.json?.data?.storage, "permission_denied"));
  checkNothingLeaked("read-only user", [health, upload], [logs.text, api.takeLogs().text].join("\n"));
}

section("the job record is rejected → write_failed, nothing left behind");
await useStandIn((name, command, context) => (isCollection("optiweb_jobs")(name, context) ? serverErrors.documentValidation() : undefined));
{
  const upload = await optimize();
  const logs = api.takeLogs();
  const entry = logs.entries.find((candidate) => candidate.operation === "job.persist:image.optimize");
  const jobId = jobInserts()[0]?.command.documents?.[0]?._id;
  check("upload is converted but not stored, with write_failed", upload.status === 200 && upload.json?.data?.status === "completed" && upload.json?.data?.persisted === false && describes(upload.json?.data?.storage, "write_failed"));
  check("log line has category write_failed at stage write, with the error code", entry?.category === "write_failed" && entry?.stage === "write" && entry?.errorCode === "121" && entry?.detail === "document_validation_failed" && entry?.requestId === upload.json?.meta?.requestId, JSON.stringify(entry ?? null).slice(0, 200));
  check("no output file was sent to the database after the job was rejected", standIn.received("insert", "optiweb_artifacts").length === 0);
  check("rollback still removes the job and its files, and is logged as completed", entry?.rollback === "completed" && nonProbeDeletes("optiweb_jobs").some((item) => item.q?._id === jobId) && nonProbeDeletes("optiweb_artifacts").some((item) => item.q?.jobId === jobId));
  check("the response does not contain the ID of the rejected job", UUID.test(jobId ?? "") && !upload.visible.includes(jobId));
  checkNothingLeaked("job rejected", [upload], logs.text);
}

section("the output files are rejected after the job was written → artifact_insert_failed, job rolled back");
await useStandIn((name, command, context) => (isCollection("optiweb_artifacts")(name, context) ? { ok: 1, n: 1, writeErrors: [{ index: 1, code: 121, errmsg: "Document failed validation" }] } : undefined));
{
  const upload = await optimize([{ name: "first.png", data: image }, { name: "second.png", data: secondImage }]);
  const logs = api.takeLogs();
  const entry = logs.entries.find((candidate) => candidate.operation === "job.persist:image.optimize");
  const job = jobInserts()[0]?.command.documents?.[0];
  const sentArtifacts = standIn.received("insert", "optiweb_artifacts")[0]?.command.documents ?? [];
  const jobDeletes = nonProbeDeletes("optiweb_jobs");
  const artifactDeletes = nonProbeDeletes("optiweb_artifacts");
  check("both files were converted", upload.json?.data?.status === "completed" && upload.json?.data?.results?.length === 2);
  check("the job record was written first, then both files were sent", jobInserts().length === 1 && sentArtifacts.length === 2 && sentArtifacts.every((doc) => doc.jobId === job?._id));
  check("response says not stored, with artifact_insert_failed", upload.json?.data?.persisted === false && describes(upload.json?.data?.storage, "artifact_insert_failed"));
  check("log line has category artifact_insert_failed at stage artifact_insert", entry?.category === "artifact_insert_failed" && entry?.stage === "artifact_insert" && entry?.requestId === upload.json?.meta?.requestId, JSON.stringify(entry ?? null).slice(0, 200));
  check("rollback deletes the job record by its ID and session", jobDeletes.length === 1 && jobDeletes[0].q?._id === job?._id && jobDeletes[0].q?.sessionId === job?.sessionId);
  check("rollback deletes every file of the job, including the one that was accepted", artifactDeletes.length === 1 && artifactDeletes[0].q?.jobId === job?._id && artifactDeletes[0].q?.sessionId === job?.sessionId && artifactDeletes[0].limit === 0);
  check("rollback is logged as completed and no rollback failure is logged", entry?.rollback === "completed" && !logs.entries.some((candidate) => candidate.event === "storage_rollback_failed"));
  const storedIds = [job?._id, ...sentArtifacts.map((doc) => doc._id)];
  check("the response contains none of the IDs that were rolled back", storedIds.every((id) => UUID.test(id ?? "") && !upload.visible.includes(id)) && upload.json?.data?.jobId === "" && upload.json?.data?.results?.every((result) => result.artifactId === null));
  checkNothingLeaked("files rejected", [upload], logs.text);
}

section("the rollback itself fails → logged with the job ID, still reported as not stored");
await useStandIn((name, command, context) => {
  if (isCollection("optiweb_artifacts")(name, context)) return serverErrors.outOfDiskSpace;
  if (name === "delete" && context.collection === "optiweb_jobs") return serverErrors.unauthorized("delete");
  return undefined;
});
{
  const upload = await optimize();
  const logs = api.takeLogs();
  const entry = logs.entries.find((candidate) => candidate.event === "storage_failure");
  const rollback = logs.entries.find((candidate) => candidate.event === "storage_rollback_failed");
  const jobId = jobInserts()[0]?.command.documents?.[0]?._id;
  check("response says not stored, with artifact_insert_failed", upload.status === 200 && upload.json?.data?.persisted === false && describes(upload.json?.data?.storage, "artifact_insert_failed"));
  check("failure line records rollback: failed and the reason for the insert failure", entry?.rollback === "failed" && entry?.detail === "out_of_disk_space" && entry?.errorCode === "14031");
  check("a storage_rollback_failed line names the leftover job and the request", rollback?.jobId === jobId && UUID.test(jobId ?? "") && rollback?.requestId === upload.json?.meta?.requestId && rollback?.category === "permission_denied" && rollback?.stage === "rollback");
  check("the other deletion was still attempted", nonProbeDeletes("optiweb_artifacts").some((item) => item.q?.jobId === jobId));
  check("the client is not given the leftover job's ID", !upload.visible.includes(jobId) && upload.json?.data?.jobId === "");
  checkNothingLeaked("rollback failed", [upload], logs.text);
}

section("the storage quota is exhausted → artifact_insert_failed with a quota detail in the log only");
await useStandIn((name, command, context) => (isCollection("optiweb_artifacts")(name, context) ? serverErrors.quotaExceeded : undefined));
{
  const upload = await optimize();
  const logs = api.takeLogs();
  const entry = logs.entries.find((candidate) => candidate.event === "storage_failure");
  check("category is artifact_insert_failed and the log detail is storage_quota_exceeded", describes(upload.json?.data?.storage, "artifact_insert_failed") && entry?.detail === "storage_quota_exceeded" && entry?.rollback === "completed");
  checkNothingLeaked("quota", [upload], logs.text, ["513 MB"]);
}

section("the connection drops while the job is written → connection_lost, rollback once the server is back");
// The driver looks for a dropped server again after 500 ms at the earliest, so
// this scenario needs a timeout above that for the rollback to find it.
process.env.OW_MONGO_TIMEOUT_MS = "3000";
await useStandIn((name, command, context) => (isCollection("optiweb_jobs")(name, context) ? "close" : undefined));
{
  const upload = await optimize();
  const logs = api.takeLogs();
  const entry = logs.entries.find((candidate) => candidate.event === "storage_failure");
  const jobId = jobInserts()[0]?.command.documents?.[0]?._id;
  check("response says not stored, with connection_lost", upload.status === 200 && upload.json?.data?.persisted === false && describes(upload.json?.data?.storage, "connection_lost"));
  check("log line has category connection_lost at stage write", entry?.category === "connection_lost" && entry?.stage === "write" && entry?.requestId === upload.json?.meta?.requestId);
  check(
    "the write may have reached the server, so the job and its files are deleted on a new connection",
    entry?.rollback === "completed" && nonProbeDeletes("optiweb_jobs").some((item) => item.q?._id === jobId) && nonProbeDeletes("optiweb_artifacts").some((item) => item.q?.jobId === jobId),
    `rollback ${entry?.rollback}`,
  );
  checkNothingLeaked("connection dropped", [upload], logs.text);
}

section("the connection drops and the server stays away → rollback failure is logged with the job ID");
process.env.OW_MONGO_TIMEOUT_MS = "400";
{
  const flaky = await startScriptedMongoServer();
  flaky.setScript((name, command, context) => {
    if (!isCollection("optiweb_jobs")(name, context)) return undefined;
    void flaky.close(); // the server goes away for good, mid-write
    return "close";
  });
  await useUri(flaky.uri("optiweb_selftest"));
  const upload = await optimize();
  const logs = api.takeLogs();
  const entry = logs.entries.find((candidate) => candidate.event === "storage_failure");
  const rollback = logs.entries.find((candidate) => candidate.event === "storage_rollback_failed");
  const jobId = flaky.received("insert", "optiweb_jobs")[0]?.command.documents?.[0]?._id;
  check("response says not stored, with connection_lost", upload.status === 200 && upload.json?.data?.persisted === false && describes(upload.json?.data?.storage, "connection_lost"));
  check("failure line records rollback: failed", entry?.category === "connection_lost" && entry?.rollback === "failed");
  check("a storage_rollback_failed line names the job that may be left behind", UUID.test(jobId ?? "") && rollback?.jobId === jobId && rollback?.requestId === upload.json?.meta?.requestId, JSON.stringify(rollback ?? null).slice(0, 200));
  check("the client is not given that job's ID", !upload.visible.includes(jobId) && upload.json?.data?.jobId === "" && upload.json?.data?.results?.every((result) => result.artifactId === null));
  checkNothingLeaked("server gone", [upload], logs.text, [`127.0.0.1:${flaky.port}`]);
  await disconnectMongo();
}

section("a query fails on a working connection → read_failed");
await useStandIn((name) => (name === "find" || name === "aggregate" ? { ok: 0, errmsg: "Executor error during find command", code: 96, codeName: "OperationFailed" } : undefined));
{
  const history = await api.call("/api/v1/history");
  const logs = api.takeLogs();
  check("history answers 503 with read_failed", history.status === 503 && history.json?.error?.code === "storage_unavailable" && history.json?.error?.details?.category === "read_failed" && history.json?.error?.message === describeStorageFailure("read_failed").message);
  check("log lines have category read_failed, stage read and the request ID", logs.entries.length > 0 && logs.entries.every((entry) => entry.category === "read_failed" && entry.stage === "read" && entry.requestId === history.json?.meta?.requestId));
  checkNothingLeaked("query failed", [history], logs.text);
}

section("stored bytes are returned intact (binary fields arrive from the driver as BSON Binary)");
{
  const artifactId = "5d0c9c1a-2b7e-4f39-8a6d-1e2f3a4b5c6d";
  const bytes = Buffer.from(Array.from({ length: 300 }, (_, index) => (index * 7) % 256));
  const document = (data) => ({ _id: artifactId, jobId: artifactId, sessionId: "any", filename: "stored.webp", itemFilename: "stored.png", contentType: "image/webp", byteSize: bytes.length, kind: "image", data, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
  const { Binary, Long } = mongoose.mongo.BSON;
  // A Binary whose backing buffer is larger than its content, as the driver can produce.
  const padded = new Binary(Buffer.alloc(0));
  padded.write(bytes, 0);
  for (const [label, data] of [["exact-size Binary", new Binary(bytes)], ["Binary with spare capacity", padded]]) {
    await useStandIn((name, command) => (name === "find" && command.find === "optiweb_artifacts" ? { ok: 1, cursor: { id: Long.fromNumber(0), ns: "optiweb_selftest.optiweb_artifacts", firstBatch: [document(data)] } } : undefined));
    const download = await api.call(`/api/v1/artifacts/${artifactId}`);
    check(`${label}: download returns exactly the stored bytes`, download.status === 200 && download.bytes.length === bytes.length && download.bytes.equals(bytes) && download.headers.get("content-length") === String(bytes.length), `status ${download.status}, ${download.bytes.length} bytes`);
  }
}

section("a successful write is reported as stored (response contract only; the stand-in keeps nothing)");
await useStandIn(undefined);
{
  const upload = await optimize([{ name: "first.png", data: image }, { name: "second.png", data: secondImage }]);
  const data = upload.json?.data;
  const sentArtifacts = standIn.received("insert", "optiweb_artifacts")[0]?.command.documents ?? [];
  check("response says stored, with a job ID and no failure fields", data?.persisted === true && JSON.stringify(data?.storage) === JSON.stringify({ persisted: true }) && UUID.test(data?.jobId ?? ""));
  check("the job ID and every artifactId are the IDs that were written", data?.jobId === jobInserts()[0]?.command.documents?.[0]?._id && data?.results?.length === 2 && data.results.every((result, index) => result.artifactId === sentArtifacts[index]?._id && result.id === result.artifactId));
  check("a stored result does not carry its file in the response", data?.results?.every((result) => result.inlineOutput === undefined && result.inlineSkipped === undefined) && !upload.visible.includes("inlineOutput"));
  check("nothing is logged for a successful write", api.takeLogs().entries.length === 0);
}

section("output files that could not be stored are sent with the response");
// The sections above used the whole request allowance of the image endpoint.
resetRateLimits();
await useUri(undefined);
{
  /** The file a result carries, decoded, or null. */
  const fileOf = (result) => (result?.inlineOutput?.encoding === "base64" ? Buffer.from(result.inlineOutput.data, "base64") : null);
  const upload = await optimize([{ name: "first.png", data: image }, { name: "second.png", data: secondImage }, { name: "notes.png", data: Buffer.from("this is not an image") }]);
  const data = upload.json?.data;
  const [first, second, broken] = data?.results ?? [];
  check("the upload is converted and reported as not stored", upload.status === 200 && data?.persisted === false && data?.storage?.category === "not_configured" && data?.status === "partial" && data?.jobId === "");
  check("each converted file is in the response, with the size the result reports", [first, second].every((result) => result?.status === "completed" && result.artifactId === null && result.inlineOutput?.encoding === "base64" && result.inlineOutput.contentType === "image/webp" && result.inlineOutput.bytes === result.outputBytes && fileOf(result)?.length === result.outputBytes && result.inlineSkipped === undefined));
  const decoded = await Promise.all([first, second].map((result) => (fileOf(result) ? sharp(fileOf(result)).metadata().catch(() => null) : null)));
  check("the bytes are the converted image: the reported format and dimensions", decoded.every((meta, index) => meta?.format === "webp" && meta.width === [first, second][index]?.outputWidth && meta.height === [first, second][index]?.outputHeight), JSON.stringify(decoded.map((meta) => meta && [meta.format, meta.width, meta.height])));
  check("the two files are different files, in upload order", fileOf(first)?.equals(fileOf(second) ?? Buffer.alloc(0)) === false && first?.filename === "first.png" && second?.filename === "second.png" && decoded[0]?.width === 48 && decoded[1]?.width === 40);
  check("a rejected file carries nothing", broken?.status === "failed" && broken.inlineOutput === undefined && broken.inlineSkipped === undefined);
  check("the response is not cacheable", (upload.headers.get("cache-control") ?? "").includes("no-store"));
  checkNothingLeaked("the response with the files", [upload], api.takeLogs().text);

  // Outputs larger than one response may carry: four incompressible PNG files of about 0.84 MB each.
  const noise = () => sharp(crypto.randomBytes(540 * 540 * 3), { raw: { width: 540, height: 540, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  const large = await Promise.all([0, 1, 2, 3].map(async (index) => ({ name: `noise-${index}.png`, data: await noise() })));
  const batch = await api.call("/api/v1/images/optimize", { method: "POST", body: imageForm(large, { format: "png" }) });
  const results = batch.json?.data?.results ?? [];
  const sent = results.filter((result) => result.inlineOutput);
  const skipped = results.filter((result) => result.inlineSkipped === "too_large");
  const sentBytes = sent.reduce((sum, result) => sum + result.inlineOutput.bytes, 0);
  const totalBytes = results.reduce((sum, result) => sum + result.outputBytes, 0);
  check("a batch whose outputs exceed the limit is still converted in full", batch.status === 200 && results.length === 4 && results.every((result) => result.status === "completed") && totalBytes > limits.maxInlineBytes, `${totalBytes} bytes of output, limit ${limits.maxInlineBytes}`);
  check("files are sent in order until the limit is reached; the rest are marked too large", sent.length === 3 && skipped.length === 1 && results[3].inlineSkipped === "too_large" && results[3].inlineOutput === null && sentBytes <= limits.maxInlineBytes, `${sent.length} sent (${sentBytes} bytes), ${skipped.length} skipped`);
  check("every file that was sent is complete", sent.every((result) => fileOf(result)?.length === result.outputBytes));
  check("the response stays below the 4.5 MB serverless response limit", batch.bytes.length < 4_500_000, `${batch.bytes.length} bytes`);
  api.takeLogs();

  check("limit: files are accepted in order while they fit", JSON.stringify(planInlineOutputs([1, 2, 3], 3)) === "[true,true,false]" && JSON.stringify(planInlineOutputs([3], 3)) === "[true]");
  check("limit: a file that does not fit is skipped and a later, smaller one is still sent", JSON.stringify(planInlineOutputs([5, 1, 2, 1], 3)) === "[false,true,true,false]");
  check("limit: a file without output is never sent", JSON.stringify(planInlineOutputs([0, 2], 3)) === "[false,true]");
  check("limit: the default is 3 MB and the environment cannot raise it", limits.maxInlineBytes === 3 * 1024 * 1024);
}

section("recovery: a failed connection is not remembered");
{
  const port = await closedPort();
  await useUri(`mongodb://127.0.0.1:${port}/optiweb_selftest`);
  const before = await api.call("/api/v1/health");
  const late = await startScriptedMongoServer(undefined, { port });
  const after = await api.call("/api/v1/health");
  check("readiness is false while nothing listens, then true once the server is up", before.json?.data?.database?.category === "connection_refused" && after.json?.data?.ok === true && after.json?.data?.database?.ready === true, `${before.json?.data?.database?.category} → ${after.json?.data?.database?.ready}`);
  await disconnectMongo();
  await late.close();
  api.takeLogs();
}

section("category list");
check("every category has a message and a hint, and none contains a connection string", STORAGE_FAILURE_CATEGORIES.length === 13 && STORAGE_FAILURE_CATEGORIES.every((category) => { const text = describeStorageFailure(category); return text.message.length > 10 && text.hint.length > 10 && !CONNECTION_STRING.test(text.message + text.hint); }));
check("the six requested categories exist", ["not_configured", "authentication_failed", "network_access_denied", "server_selection_timeout", "write_failed", "artifact_insert_failed"].every((category) => STORAGE_FAILURE_CATEGORIES.includes(category)));

/* ----------------------------------------------------------------- summary */
await disconnectMongo();
await standIn.close();
hangsUp.close();
neverAnswers.close();
await api.close();
const ok = report();
if (ok) console.log("\nAll storage diagnostics checks passed.");
process.exit(ok ? 0 : 1);
