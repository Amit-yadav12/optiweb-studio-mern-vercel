/** Security probe: injection, traversal, malformed input, oversized payloads. */
const B = process.argv[2] ?? "http://127.0.0.1:5000";

let failures = 0;

async function probe(label, path, expectStatus, init) {
  try {
    const r = await fetch(B + path, init);
    const ct = r.headers.get("content-type") || "";
    let summary;
    if (ct.includes("json")) {
      const body = await r.json();
      summary = body.ok === false ? `err:${body.error.code}` : "ok";
    } else {
      summary = "binary/text";
    }
    const pass = Array.isArray(expectStatus) ? expectStatus.includes(r.status) : r.status === expectStatus;
    if (!pass) failures += 1;
    console.log(`${pass ? "✓" : "✗"} ${label.padEnd(44)} -> ${r.status} ${summary}`);
  } catch (e) {
    failures += 1;
    console.log(`✗ ${label.padEnd(44)} -> THREW ${e.message}`);
  }
}

await probe("history q=' OR 1=1 --", "/api/v1/history?q=%27%20OR%201%3D1%20--", 200);
await probe("history kind=SQL injection", "/api/v1/history?kind=%27%3B%20DROP%20TABLE%20jobs%3B--", 422);
await probe("artifact id=../../etc/passwd", "/api/v1/artifacts/..%2F..%2Fetc%2Fpasswd", 404);
await probe("artifact id=not-a-uuid", "/api/v1/artifacts/not-a-uuid", 404);
await probe("history detail id=not-a-uuid", "/api/v1/history/not-a-uuid", 404);
await probe("images optimize JSON body", "/api/v1/images/optimize", 400, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
await probe("images optimize no body", "/api/v1/images/optimize", 400, { method: "POST" });
await probe("history pageSize=99999", "/api/v1/history?pageSize=99999", 422);
await probe("history page=-5", "/api/v1/history?page=-5", 422);
await probe("history page=abc", "/api/v1/history?page=abc", 422);
await probe("css ~2.4MB body over cap", "/api/v1/css/analyze", 422, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ css: "a{color:red}".repeat(200000) }),
});
await probe("GET on css/analyze (method)", "/api/v1/css/analyze", 405);
await probe("zip with foreign/random uuid", "/api/v1/artifacts/zip", 400, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ids: ["00000000-0000-4000-8000-000000000000"] }),
});
await probe("zip with non-uuid ids", "/api/v1/artifacts/zip", [400, 422], {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ids: ["../../etc/passwd"] }),
});
await probe("preferences quality below range", "/api/v1/preferences", 422, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ defaultQuality: 5 }),
});
await probe("preferences quality=1e9", "/api/v1/preferences", 422, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ defaultQuality: 1e9 }),
});
await probe("preferences NaN quality", "/api/v1/preferences", 422, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ defaultQuality: "abc" }),
});
await probe("preferences negative threshold", "/api/v1/preferences", 422, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ analyzerThresholdKb: -5 }),
});

console.log(failures === 0 ? "\nAll security probes behaved correctly." : `\n${failures} probe(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
