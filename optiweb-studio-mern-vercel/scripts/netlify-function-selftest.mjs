#!/usr/bin/env node
/**
 * Exercises the real Netlify serverless-http function adapter without Netlify
 * credentials or an Atlas database. Never run persistence cases against a live
 * MONGODB_URI; use scripts/api-selftest.mjs with a dedicated test database.
 */
import assert from "node:assert/strict";
import sharp from "sharp";

if (process.env.MONGODB_URI || process.env.MONGO_URL) {
  throw new Error("Refusing to run the no-database function smoke test with a MongoDB URI configured.");
}
process.env.NETLIFY = "true";
const { handler } = await import("../netlify/functions/api.ts");

const context = { functionName: "api", awsRequestId: "function-smoke-test" };
function makeEvent({ method = "GET", path, headers = {}, body = "", isBase64Encoded = false }) {
  return {
    httpMethod: method,
    path,
    headers: { host: "localhost", "x-forwarded-proto": "http", ...headers },
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    body,
    isBase64Encoded,
    requestContext: { identity: { sourceIp: "127.0.0.1" }, requestId: "netlify-function-smoke" },
  };
}
async function invoke(event) {
  return handler(event, context);
}
function json(response) {
  assert.match(response.headers?.["content-type"] ?? "", /application\/json/i);
  return JSON.parse(response.body);
}

let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log(`✓ ${name}`);
}

const health = await invoke(makeEvent({ path: "/api/v1/health" }));
const healthBody = json(health);
check("rewritten /api/v1/health reaches the mounted Express API", health.statusCode === 200 && healthBody.ok === true);
check("Express response includes a request correlation id", Boolean(health.headers["x-request-id"]));
const setCookie = health.headers?.["set-cookie"] ?? health.multiValueHeaders?.["set-cookie"]?.join("; ") ?? "";
check("HTTP-only guest session cookie survives the function adapter", /ow_sid=.*HttpOnly.*SameSite=Lax/i.test(setCookie));
check("Sharp native runtime is available", healthBody.data.sharp.available === true);
check("unconfigured MongoDB is reported honestly", healthBody.data.database.connected === false);
const directFunctionHealth = await invoke(makeEvent({ path: "/.netlify/functions/api/api/v1/health" }));
check("direct Netlify Function mount is normalized without duplicating /api", directFunctionHealth.statusCode === 200 && json(directFunctionHealth).data.service === "OptiWeb Studio");

const limits = json(await invoke(makeEvent({ path: "/api/v1/limits" })));
check("runtime AVIF encoder probe is reflected in API limits", limits.data.avifSupported === true && limits.data.imageFormats.includes("avif"));

const css = "@font-face { font-family: Demo; src: url(demo.woff2); }\nbody { color: #17212b; }";
const cssAnalyze = await invoke(makeEvent({
  method: "POST",
  path: "/api/v1/css/analyze",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ css }),
}));
const cssAnalysisBody = json(cssAnalyze);
check("JSON API body reaches PostCSS analysis with the expected path", cssAnalyze.statusCode === 200 && cssAnalysisBody.data.fontFaceCount === 1);

const cssPatch = await invoke(makeEvent({
  method: "POST",
  path: "/api/v1/css/patch-font-display",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ css, policy: "swap" }),
}));
const patchBody = json(cssPatch);
check("CSS patch transforms the actual stylesheet and discloses non-persistence", cssPatch.statusCode === 200 && /font-display:\s*swap/.test(patchBody.data.output) && patchBody.data.persisted === false);

const first = await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 36, g: 92, b: 230 } } }).jpeg({ quality: 92 }).toBuffer();
const second = await sharp({ create: { width: 80, height: 50, channels: 4, background: { r: 255, g: 0, b: 120, alpha: 0.5 } } }).png().toBuffer();
const assetPng = await sharp({ create: { width: 24, height: 18, channels: 4, background: { r: 20, g: 160, b: 90, alpha: 0.7 } } }).png().toBuffer();
const assetForm = new FormData();
assetForm.append("files", new Blob([assetPng], { type: "image/png" }), "asset.png");
assetForm.append("files", new Blob([css], { type: "text/css" }), "site.css");
const assetRequest = new Request("https://localhost/api/v1/assets/analyze", { method: "POST", body: assetForm });
const assetBytes = Buffer.from(await assetRequest.arrayBuffer());
const assetResponse = await invoke(makeEvent({
  method: "POST",
  path: "/api/v1/assets/analyze",
  headers: { "content-type": assetRequest.headers.get("content-type") },
  body: assetBytes.toString("base64"),
  isBase64Encoded: true,
}));
const assetBody = json(assetResponse);
check("Asset Analyzer returns real dimensions for images and routes CSS findings", assetResponse.statusCode === 200 && assetBody.data.files.length === 2 && assetBody.data.files.some((file) => file.width === 24 && file.height === 18) && assetBody.data.files.some((file) => file.kind === "css"));

const auditResponse = await invoke(makeEvent({ method: "POST", path: "/api/v1/audits", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://127.0.0.1:9999" }) }));
const auditBody = json(auditResponse);
check("Website Audit blocks a loopback SSRF target with a safe JSON error", auditResponse.statusCode === 400 && auditBody.error.code === "bad_request");

const historyResponse = await invoke(makeEvent({ path: "/api/v1/history" }));
const historyBody = json(historyResponse);
check("history returns an actionable 503 when MongoDB is not configured", historyResponse.statusCode === 503 && historyBody.error.code === "storage_unavailable");

const form = new FormData();
form.append("files", new Blob([first], { type: "image/jpeg" }), "blue.jpg");
form.append("files", new Blob([second], { type: "image/png" }), "alpha.png");
form.append("format", "webp");
form.append("quality", "78");
const request = new Request("https://localhost/api/v1/images/optimize", { method: "POST", body: form });
const multipartBody = Buffer.from(await request.arrayBuffer());
const optimize = await invoke(makeEvent({
  method: "POST",
  path: "/api/v1/images/optimize",
  headers: { "content-type": request.headers.get("content-type"), "content-length": String(multipartBody.byteLength) },
  body: multipartBody.toString("base64"),
  isBase64Encoded: true,
}));
const optimizeBody = json(optimize);
check("Base64 multipart upload preserves its boundary through Netlify and Express", optimize.statusCode === 200 && optimizeBody.data.results.length === 2);
check("two real images are converted by Sharp to WebP", optimizeBody.data.results.every((result) => result.status === "completed" && result.outputFormat === "webp" && result.outputBytes > 0));
check("image workflow discloses that stored downloads require MongoDB persistence", optimizeBody.data.persisted === false && optimizeBody.data.results.every((result) => result.status === "completed" && result.artifactId === null));
const sentFiles = optimizeBody.data.results.map((result) => (result.inlineOutput?.encoding === "base64" ? Buffer.from(result.inlineOutput.data, "base64") : null));
const sentFormats = await Promise.all(sentFiles.map((file) => (file ? sharp(file).metadata().then((meta) => meta.format, () => null) : null)));
check("without storage, the converted files come back in the function's response, intact", sentFiles.every((file, index) => file !== null && file.length === optimizeBody.data.results[index].outputBytes) && sentFormats.every((format) => format === "webp"), sentFormats.join(", "));
check("the function response with the files stays below Netlify's 6 MB response limit", Buffer.byteLength(optimize.body ?? "", optimize.isBase64Encoded ? "base64" : "utf8") < 6_000_000 && optimize.isBase64Encoded !== true);

const avifForm = new FormData();
avifForm.append("files", new Blob([first], { type: "image/jpeg" }), "avif-check.jpg");
avifForm.append("format", "avif");
const avifRequest = new Request("https://localhost/api/v1/images/optimize", { method: "POST", body: avifForm });
const avifBytes = Buffer.from(await avifRequest.arrayBuffer());
const avifResponse = await invoke(makeEvent({ method: "POST", path: "/api/v1/images/optimize", headers: { "content-type": avifRequest.headers.get("content-type") }, body: avifBytes.toString("base64"), isBase64Encoded: true }));
const avifBody = json(avifResponse);
check("Sharp actually encodes an AVIF output when the runtime probe is positive", avifResponse.statusCode === 200 && avifBody.data.results[0]?.outputFormat === "avif" && avifBody.data.results[0]?.outputBytes > 0);

const invalid = await invoke(makeEvent({
  method: "POST",
  path: "/api/v1/images/optimize",
  headers: { "content-type": "application/json" },
  body: "{}",
}));
const invalidBody = json(invalid);
check("invalid content type receives a consistent JSON 400 instead of an HTML 500", invalid.statusCode === 400 && invalidBody.ok === false);

console.log(`\n${passed} Netlify function adapter checks passed (MongoDB persistence intentionally untested).`);
