#!/usr/bin/env node
/**
 * Self-test of the Netlify function, through its real adapter. Needs no
 * Netlify account and no network.
 *
 *   npm run test:function
 *
 * On Netlify the API is one function. A request reaches it as an event object,
 * with a body that may be base64 encoded, and the answer goes back as an
 * object. This test builds such events and calls the function's handler, so
 * it covers what the HTTP tests cannot: that paths, JSON bodies, headers and
 * refusals survive the adapter.
 *
 * It does not cover Netlify's own routing (the redirect of /api/* to the
 * function) or its bundler. `npm run smoke -- <site>` checks a deployed site.
 */
import { createChecker, fixture, UUID } from "./lib/selftest-kit.mjs";

const { check, section, report, crashed } = createChecker("netlify-function-selftest");
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

process.env.NETLIFY = "true";
delete process.env.PAGESPEED_API_KEY;
const { handler } = await import("../netlify/functions/api.ts");
const { SECURITY_HEADERS } = await import("../src/server/config/securityHeaders.ts");

const context = { functionName: "api" };
let clients = 0;
/** One invocation, shaped as Netlify shapes it. Each call site may name a client, so the audit's rate limit does not carry over. */
async function invoke({ method = "GET", path, headers = {}, body = "", isBase64Encoded = false, client = "203.0.113.200" }) {
  const response = await handler(
    {
      httpMethod: method,
      path,
      headers: { host: "example.netlify.app", "x-forwarded-proto": "https", "x-forwarded-for": client, ...headers },
      multiValueHeaders: {},
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      body,
      isBase64Encoded,
      requestContext: { identity: { sourceIp: client } },
    },
    context,
  );
  const type = String(response.headers?.["content-type"] ?? "");
  let json = null;
  if (type.includes("json")) {
    try {
      json = JSON.parse(response.isBase64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body);
    } catch {
      json = null;
    }
  }
  return { ...response, type, json, cookies: response.headers?.["set-cookie"] ?? response.multiValueHeaders?.["set-cookie"] ?? null };
}
const nextClient = () => `203.0.113.${(clients += 1)}`;
const jsonBody = (value) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

section("the function answers as the API");
{
  const health = await invoke({ path: "/api/v1/health" });
  check("a request rewritten from /api/v1/health reaches the app", health.statusCode === 200 && health.json?.ok === true && health.json.data.service === "Unikit Studio");
  check("the answer states that nothing is uploaded or stored", health.json.data.acceptsFileUploads === false && health.json.data.storesFiles === false && health.json.data.usesCookies === false && health.json.data.processing.images === "browser");
  check("it carries a request ID in the header and in the body", UUID.test(String(health.headers["x-request-id"])) && health.json.meta.requestId === health.headers["x-request-id"]);
  check("it sets no cookie", health.cookies === null);
  const missing = Object.entries(SECURITY_HEADERS).filter(([name, value]) => health.headers[name.toLowerCase()] !== value).map(([name]) => name);
  check("the security headers survive the adapter", missing.length === 0, missing.join(", "));
  check("a JSON answer is sent as text, not as base64", health.isBase64Encoded !== true && typeof health.body === "string" && health.body.startsWith("{"));
  const direct = await invoke({ path: "/.netlify/functions/api/api/v1/health" });
  check("the function's own address works too, without doubling the path", direct.statusCode === 200 && direct.json?.data?.service === "Unikit Studio");
  const traced = await invoke({ path: "/api/v1/health", headers: { "x-request-id": "trace-abc-123" } });
  check("a plain request ID supplied by the caller is kept, so one ID follows a request through the logs", traced.headers["x-request-id"] === "trace-abc-123" && traced.json.meta.requestId === "trace-abc-123");
  const plain = await invoke({ path: "/api/health" });
  check("the plain health check for monitors answers", plain.statusCode === 200 && plain.json?.ok === true && plain.json.acceptsFileUploads === false);
  const unknown = await invoke({ path: "/api/v1/nothing-here" });
  check("an unknown API path is a JSON 404 from the app, not an error of the adapter", unknown.statusCode === 404 && unknown.json?.error?.code === "not_found");
}

section("the audit endpoint through the adapter");
{
  const client = nextClient();
  const empty = await invoke({ path: "/api/v1/audits", client, ...jsonBody({}) });
  check("a JSON body arrives and is validated: an empty object is a 422 that names the url field", empty.statusCode === 422 && empty.json?.error?.code === "validation_error" && empty.json.error.details.some((detail) => detail.path === "url"), JSON.stringify(empty.json));
  const encoded = await invoke({ path: "/api/v1/audits", client, method: "POST", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ url: "http://127.0.0.1:9/" })).toString("base64"), isBase64Encoded: true });
  check("a JSON body that Netlify delivers base64 encoded is decoded, and a loopback address in it is refused", encoded.statusCode === 400 && encoded.json?.error?.code === "bad_request" && /not a public website/.test(encoded.json.error.message), JSON.stringify(encoded.json));
  const metadata = await invoke({ path: "/api/v1/audits", client, ...jsonBody({ url: "http://169.254.169.254/latest/meta-data/" }) });
  check("the cloud metadata address is refused", metadata.statusCode === 400 && metadata.json?.error?.code === "bad_request");
  const broken = await invoke({ path: "/api/v1/audits", client, method: "POST", headers: { "content-type": "application/json" }, body: '{"url": ' });
  check("malformed JSON is a JSON 400", broken.statusCode === 400 && broken.json?.error?.code === "bad_request");
  const wrongMethod = await invoke({ path: "/api/v1/audits", client });
  check("GET is refused with 405 and the allowed method", wrongMethod.statusCode === 405 && wrongMethod.headers.allow === "POST");
  const limited = nextClient();
  const statuses = [];
  for (let attempt = 0; attempt < 11; attempt += 1) statuses.push((await invoke({ path: "/api/v1/audits", client: limited, ...jsonBody({}) })).statusCode);
  check("the rate limit sees the visitor's address, not the proxy's: the eleventh request of one visitor is a 429", statuses.slice(0, 10).every((status) => status === 422) && statuses[10] === 429, statuses.join(" "));
  const other = await invoke({ path: "/api/v1/audits", client: nextClient(), ...jsonBody({}) });
  check("and another visitor is not affected", other.statusCode === 422);
}

section("uploads through the adapter: refused, whatever the encoding");
{
  const canary = `CANARY-${Date.now().toString(36)}`;
  const form = new FormData();
  form.append("files", new Blob([fixture("photo-800x600.jpg")], { type: "image/jpeg" }), `${canary}.jpg`);
  form.append("format", "webp");
  const request = new Request("https://example.netlify.app/api/v1/images/optimize", { method: "POST", body: form });
  const multipart = Buffer.from(await request.arrayBuffer());
  const upload = (path) => invoke({ path, method: "POST", headers: { "content-type": request.headers.get("content-type"), "content-length": String(multipart.length) }, body: multipart.toString("base64"), isBase64Encoded: true, client: nextClient() });
  const old = await upload("/api/v1/images/optimize");
  check(`a ${Math.round(multipart.length / 1024)} KB multipart upload to the old image endpoint is answered 410 Gone`, old.statusCode === 410 && old.json?.error?.code === "gone" && /in the browser/.test(old.json.error.hint ?? ""), `${old.statusCode} ${old.json?.error?.code}`);
  const audits = await upload("/api/v1/audits");
  check("the same upload to the audit endpoint is answered 415: it takes JSON only", audits.statusCode === 415 && audits.json?.error?.code === "unsupported_media_type");
  const elsewhere = await upload("/api/v1/upload");
  check("and to any other API path, 404", elsewhere.statusCode === 404 && elsewhere.json?.error?.code === "not_found");
  check("no answer repeats the file's name or contents", [old, audits, elsewhere].every((response) => !String(response.body).includes(canary) && String(response.body).length < 2_000));
  check("no answer sets a cookie", [old, audits, elsewhere].every((response) => response.cookies === null));
  const removed = [];
  for (const path of ["/api/v1/history", "/api/v1/usage", "/api/v1/limits", "/api/v1/session", "/api/v1/preferences", "/api/v1/artifacts/abc", "/api/v1/jobs/abc", "/api/v1/internal/cleanup"]) {
    const response = await invoke({ path, client: nextClient() });
    if (response.statusCode !== 410) removed.push(`${path} → ${response.statusCode}`);
  }
  check("the storage, history and job endpoints of earlier versions answer 410", removed.length === 0, removed.join("; "));
}

const ok = report();
if (ok) console.log("\nAll Netlify function checks passed.");
process.exit(ok ? 0 : 1);
