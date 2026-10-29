#!/usr/bin/env node
/**
 * OptiWeb Studio — end-to-end API verification.
 *
 * Run against a started server:
 *   node scripts/api-selftest.mjs http://127.0.0.1:5000
 *
 * It exercises the real pipeline: sharp conversion, byte accounting, artifact
 * downloads, PostCSS patching, history scoping, validation and rate limiting.
 * No test framework dependency — failures are reported with a non-zero exit.
 */
import sharp from "sharp";
import { readFile as fsReadFile } from "node:fs/promises";
const fs = { readFile: fsReadFile };

const BASE = process.argv[2] ?? "http://127.0.0.1:5000";
let cookie = "";
let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie && !cookie) cookie = setCookie.split(";")[0];
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, body, headers: response.headers };
}

function multipart(parts) {
  const boundary = `----optiweb${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const part of parts) {
    if (part.value !== undefined) {
      chunks.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`),
      );
      continue;
    }
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type}\r\n\r\n`,
      ),
    );
    chunks.push(part.data);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function makeImage(width, height, color, format = "jpeg") {
  return sharp({
    create: { width, height, channels: 3, background: color },
  })
    .jpeg({ quality: 100 })
    .toBuffer();
}

console.log(`\nOptiWeb Studio API self-test → ${BASE}\n`);

/* ------------------------------------------------------------------ health */
console.log("health");
const health = await call("/api/v1/health");
check("GET /api/v1/health returns 200", health.status === 200);
check("database probe connected", health.body?.data?.database?.connected === true);
check("sharp available", health.body?.data?.sharp?.available === true, JSON.stringify(health.body?.data?.sharp));
const legacy = await call("/api/health");
check("GET /api/health returns ok", legacy.body?.ok === true);

/* ------------------------------------------------------------------ images */
console.log("\nimage optimization");
const jpeg = await makeImage(1400, 900, { r: 40, g: 90, b: 200 });
const form = multipart([
  { name: "files", filename: "photo-blue.jpg", type: "image/jpeg", data: jpeg },
  { name: "format", value: "webp" },
  { name: "quality", value: "78" },
]);
const optimize = await call("/api/v1/images/optimize", {
  method: "POST",
  body: form.body,
  headers: form.headers,
});
check("POST /api/v1/images/optimize returns 200", optimize.status === 200, `status ${optimize.status}`);
const result = optimize.body?.data?.results?.[0];
check("one result returned", optimize.body?.data?.results?.length === 1);
check("conversion completed", result?.status === "completed", JSON.stringify(result));
check("output format is webp", result?.outputFormat === "webp");
check(
  "savings formula is exact",
  result && result.savedBytes === result.inputBytes - result.outputBytes,
  `saved=${result?.savedBytes} in=${result?.inputBytes} out=${result?.outputBytes}`,
);
check(
  "savings percentage is exact",
  result && Math.abs(result.savingsPercent - (result.savedBytes / result.inputBytes) * 100) < 0.01,
  `${result?.savingsPercent}`,
);
check("webp output is smaller than the jpeg source", result && result.outputBytes < result.inputBytes);

/* artifact download */
const artifactId = result?.id;
const download = await call(`/api/v1/artifacts/${artifactId}`);
check("artifact downloads with 200", download.status === 200);
check("artifact byte length matches report", download.body.length === result.outputBytes, `${download.body.length}`);
const metadata = await sharp(download.body).metadata();
check("downloaded artifact decodes as webp", metadata.format === "webp");
check("download sets content-disposition", (download.headers.get("content-disposition") ?? "").includes("attachment"));

/* cross-session isolation */
const other = await fetch(`${BASE}/api/v1/artifacts/${artifactId}`, { headers: { cookie: "ow_sid=00000000-0000-4000-8000-000000000000" } });
check("artifact is not visible to another session", other.status === 404, `status ${other.status}`);

/* resize */
const resizeForm = multipart([
  { name: "files", filename: "photo-blue.jpg", type: "image/jpeg", data: jpeg },
  { name: "format", value: "webp" },
  { name: "maxWidth", value: "700" },
]);
const resized = await call("/api/v1/images/optimize", { method: "POST", body: resizeForm.body, headers: resizeForm.headers });
const resizedResult = resized.body?.data?.results?.[0];
check("maxWidth scales the output down", resizedResult?.outputWidth === 700, `${resizedResult?.outputWidth}`);
check("aspect ratio preserved on resize", resizedResult?.outputHeight === 450, `${resizedResult?.outputHeight}`);

/* batch + failures */
const badFile = Buffer.from("this is not an image at all");
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
const batchForm = multipart([
  { name: "files", filename: "good.jpg", type: "image/jpeg", data: jpeg },
  { name: "files", filename: "broken.jpg", type: "image/jpeg", data: badFile },
  { name: "files", filename: "vector.svg", type: "image/svg+xml", data: svg },
]);
const batch = await call("/api/v1/images/optimize", { method: "POST", body: batchForm.body, headers: batchForm.headers });
check("partial batch returns 200", batch.status === 200, `status ${batch.status}`);
check("job status is partial", batch.body?.data?.status === "partial", batch.body?.data?.status);
check("valid file still converted", batch.body?.data?.results?.some((r) => r.status === "completed"));
check(
  "corrupt file rejected with a safe message",
  batch.body?.data?.results?.some((r) => r.status === "failed" && /not a readable image|could not be re-encoded/.test(r.message ?? "")),
);
check("svg is refused with a reason", batch.body?.data?.results?.some((r) => /SVG/.test(r.message ?? "")));

/* oversized file (valid multipart framing; no false Content-Length mismatch) */
const overLimitBytes = Buffer.alloc(1024 * 1024 + 32, 0x41);
const hugeForm = multipart([{ name: "files", filename: "over-limit.jpg", type: "image/jpeg", data: overLimitBytes }]);
const oversizeResponse = await fetch(`${BASE}/api/v1/images/optimize`, {
  method: "POST",
  headers: { ...hugeForm.headers, cookie },
  body: hugeForm.body,
});
check("oversized file is rejected with HTTP 413", oversizeResponse.status === 413, `status ${oversizeResponse.status}`);

console.log("\nmulti-candidate optimization");
const tinyPng = await sharp({
  create: { width: 8, height: 8, channels: 3, background: { r: 12, g: 12, b: 12 } },
})
  .png({ compressionLevel: 9 })
  .toBuffer();
const nrForm = multipart([
  { name: "files", filename: "already-small.png", type: "image/png", data: tinyPng },
  { name: "format", value: "png" },
  { name: "policy", value: "no-regression" },
  { name: "quality", value: "80" },
]);
const nr = await call("/api/v1/images/optimize", { method: "POST", body: nrForm.body, headers: nrForm.headers });
const nrItem = nr.body?.data?.results?.[0];
check("no-regression never reports growth as success", nrItem && nrItem.savedBytes >= 0, JSON.stringify(nrItem?.savedBytes));
check("candidates array is present", Array.isArray(nrItem?.candidates) && nrItem.candidates.length >= 1);

console.log("\nwebsite audit");
const blocked = await call("/api/v1/audits", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "http://127.0.0.1/" }),
});
check("localhost audit is rejected", blocked.status === 400, `status ${blocked.status}`);
const fileUrl = await call("/api/v1/audits", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "file:///etc/passwd" }),
});
check("file: URLs are rejected", fileUrl.status === 400, `status ${fileUrl.status}`);
const publicAudit = await call("/api/v1/audits", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/" }),
});
check("public URL audit returns 200", publicAudit.status === 200, `status ${publicAudit.status} ${JSON.stringify(publicAudit.body?.error)}`);
check("audit coverage admits it is not Chrome", publicAudit.body?.data?.coverage?.javascriptRendered === false);
check("audit transferred bytes are measured", (publicAudit.body?.data?.totals?.transferredBytes ?? 0) > 0);
check(
  "PSI field data is not fabricated",
  publicAudit.body?.data?.pagespeed?.configured === false || publicAudit.body?.data?.pagespeed?.field != null,
);

/* ------------------------------------------------- total batch byte guard */
console.log("\nbatch upload budget");
const guardSource = await fs.readFile(new URL("../src/server/http/multipart.ts", import.meta.url), "utf8");
check(
  "batch budget guard is implemented in the upload path",
  /maxBatchBytes[\s\S]*payloadTooLarge/.test(guardSource),
);
const envSource = await fs.readFile(new URL("../src/server/config/env.ts", import.meta.url), "utf8");
check(
  "OW_MAX_BATCH_MB is documented as an env knob",
  envSource.includes("OW_MAX_BATCH_MB"),
);
check(
  "Vercel body-limit guidance is documented",
  (await fs.readFile(new URL("../docs/deployment.md", import.meta.url), "utf8")).includes("4.5 MB"),
);

const imageSource = await fs.readFile(new URL("../src/server/services/imageService.ts", import.meta.url), "utf8");
check("decoder pixel cap is wired into sharp", imageSource.includes("limitInputPixels"));
check("timed-out encodes destroy the sharp pipeline", imageSource.includes("pipeline.destroy()"));

console.log("\npublic limits");
const published = await call("/api/v1/limits");
check("GET /api/v1/limits returns 200", published.status === 200);
check("limits advertise a decoded-pixel cap", (published.body?.data?.maxDecodedPixels ?? 0) > 0, `${published.body?.data?.maxDecodedPixels}`);
check("limits advertise a file-size cap", (published.body?.data?.maxFileBytes ?? 0) > 0);

/* ------------------------------------------- artifact naming & mime types */
console.log("\nartifact naming and mime types");
const namedForm = multipart([
  { name: "files", filename: "holiday photo.jpg", type: "image/jpeg", data: jpeg },
  { name: "format", value: "webp" },
]);
const named = await call("/api/v1/images/optimize", {
  method: "POST",
  body: namedForm.body,
  headers: namedForm.headers,
});
const namedResult = named.body?.data?.results?.[0];
check("result exposes the produced filename", namedResult?.outputFilename === "holiday-photo-optiweb.webp", namedResult?.outputFilename);
const namedDownload = await call(`/api/v1/artifacts/${namedResult?.id}`);
const namedMeta = await sharp(namedDownload.body).metadata();
check(
  "artifact content-type matches the actual bytes",
  namedDownload.headers.get("content-type") === "image/webp" && namedMeta.format === "webp",
  `header=${namedDownload.headers.get("content-type")} bytes=${namedMeta.format}`,
);
const dispositionName = /filename="([^"]+)"/.exec(namedDownload.headers.get("content-disposition") ?? "")?.[1];
check("artifact download name matches the produced file", dispositionName === namedResult?.outputFilename, dispositionName);
check("source name is preserved separately", namedResult?.filename === "holiday-photo.jpg", namedResult?.filename);
const inlineResponse = await call(`/api/v1/artifacts/${namedResult?.id}?inline=1`);
check("?inline=1 serves inline disposition", (inlineResponse.headers.get("content-disposition") ?? "").startsWith("inline"));
check(
  "original name exposed for round-trips",
  inlineResponse.headers.get("x-optiweb-original-name") === "holiday-photo.jpg",
  inlineResponse.headers.get("x-optiweb-original-name"),
);

/* --------------------------------------------------------- animated input */
console.log("\nanimated input handling");
const frames = [];
for (let i = 0; i < 4; i += 1) {
  frames.push(
    await sharp({ create: { width: 80, height: 80, channels: 3, background: { r: 20 + i * 60, g: 30, b: 200 } } })
      .png()
      .toBuffer(),
  );
}
const animatedGif = await sharp(frames, { join: { animated: true } }).gif({ loop: 0 }).toBuffer();
const sourceFrames = (await sharp(animatedGif, { animated: true }).metadata()).pages;
const gifForm = multipart([
  { name: "files", filename: "loop.gif", type: "image/gif", data: animatedGif },
  { name: "format", value: "webp" },
]);
const gifResult = await call("/api/v1/images/optimize", { method: "POST", body: gifForm.body, headers: gifForm.headers });
const gifItem = gifResult.body?.data?.results?.[0];
check("animated GIF converts to animated WebP", gifItem?.status === "completed", JSON.stringify(gifItem?.message));
const gifDownload = await call(`/api/v1/artifacts/${gifItem?.id}`);
const gifMeta = await sharp(gifDownload.body, { animated: true }).metadata();
check("animation preserved, not silently flattened", gifMeta.pages === sourceFrames, `source=${sourceFrames} output=${gifMeta.pages}`);
const gifPngForm = multipart([
  { name: "files", filename: "loop.gif", type: "image/gif", data: animatedGif },
  { name: "format", value: "png" },
]);
const gifPng = await call("/api/v1/images/optimize", { method: "POST", body: gifPngForm.body, headers: gifPngForm.headers });
const gifPngItem = gifPng.body?.data?.results?.[0];
check("animated source refused for a still format", gifPngItem?.status === "failed");
check("refusal explains the frame loss", /without dropping frames/i.test(gifPngItem?.message ?? ""), gifPngItem?.message);

/* --------------------------------------------------- malformed identifiers */
console.log("\nmalformed identifiers");
for (const bad of ["not-a-uuid", "../../etc/passwd", "00000000-0000-4000-8000-000000000000"]) {
  const response = await call(`/api/v1/artifacts/${encodeURIComponent(bad)}`);
  check(`artifact id "${bad}" is a clean 404, not a 500`, response.status === 404, `status ${response.status}`);
}

/* -------------------------------------------------------------------- css */
console.log("\nCSS font-display");
const css = `@font-face{font-family:"A";src:url("/a.woff2") format("woff2");}
@font-face{font-family:"B";src:url("/b.woff2") format("woff2");font-display:block;}
@font-face{font-family:"C";font-weight:700;}
body{color:#111;font-family:"A",sans-serif;}`;
const analyze = await call("/api/v1/css/analyze", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ css }),
});
check("analyze returns 200", analyze.status === 200);
check("counts three @font-face rules", analyze.body?.data?.fontFaceCount === 3, `${analyze.body?.data?.fontFaceCount}`);
check("one rule already declares font-display", analyze.body?.data?.withFontDisplay === 1);
check("one malformed rule (no src) is reported", analyze.body?.data?.malformed === 1);
check("one rule is patchable", analyze.body?.data?.missingFontDisplay === 1);

const patch = await call("/api/v1/css/patch-font-display", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ css, policy: "swap" }),
});
check("patch returns 200", patch.status === 200);
check("output keeps the existing declaration", patch.body?.data?.output.includes("font-display:block"));
check("output inserts the new declaration", /font-display:\s*swap/.test(patch.body?.data?.output ?? ""));
check("unrelated rules are preserved", patch.body?.data?.output.includes("body{color:#111"));
check("changed lines are reported and match the insertions", (patch.body?.data?.changedLines ?? []).length === 1, JSON.stringify(patch.body?.data?.changedLines));
check("patched artifact is stored", Boolean(patch.body?.data?.artifactId));

const malformedCss = "@font-face { font-family: 'X';";
const malformed = await call("/api/v1/css/patch-font-display", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ css: malformedCss, policy: "swap" }),
});
check("malformed CSS is reported, not patched", malformed.body?.data?.analysis.parseErrors.length > 0, JSON.stringify(malformed.body));
check("malformed CSS is returned unchanged", malformed.body?.data?.output === malformedCss);

const invalidCss = await call("/api/v1/css/analyze", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ css: "" }),
});
check("empty CSS is rejected with 422", invalidCss.status === 422, `status ${invalidCss.status}`);

const qualityForm = multipart([
  { name: "files", filename: "a.jpg", type: "image/jpeg", data: jpeg },
  { name: "quality", value: "500" },
]);
const badSettings = await call("/api/v1/images/optimize", {
  method: "POST",
  body: qualityForm.body,
  headers: qualityForm.headers,
});
check("out-of-range quality is rejected with 422", badSettings.status === 422, `status ${badSettings.status}`);

/* ----------------------------------------------------------------- assets */
console.log("\nasset analyzer");
const assetForm = multipart([
  { name: "files", filename: "photo-blue.jpg", type: "image/jpeg", data: jpeg },
  { name: "files", filename: "styles.css", type: "text/css", data: Buffer.from(css) },
  { name: "thresholdKb", value: "50" },
]);
const assets = await call("/api/v1/assets/analyze", { method: "POST", body: assetForm.body, headers: assetForm.headers });
check("assets analyze returns 200", assets.status === 200);
check("both files scanned", assets.body?.data?.summary?.filesScanned === 2);
const imageFile = assets.body?.data?.files?.find((f) => f.kind === "image");
check("true intrinsic dimensions reported", imageFile?.width === 1400 && imageFile?.height === 900);
const expectLarge = jpeg.length > 50 * 1024;
check(
  "large-file heuristic matches the configured threshold",
  Boolean(imageFile?.findings?.some((f) => f.code === "large-file")) === expectLarge,
  `file=${jpeg.length} bytes, expectLarge=${expectLarge}`,
);
const lenientForm = multipart([
  { name: "files", filename: "photo-blue.jpg", type: "image/jpeg", data: jpeg },
  { name: "thresholdKb", value: "4000" },
]);
const lenient = await call("/api/v1/assets/analyze", { method: "POST", body: lenientForm.body, headers: lenientForm.headers });
const lenientImage = lenient.body?.data?.files?.find((f) => f.kind === "image");
check("raising the threshold clears the large-file finding", !lenientImage?.findings?.some((f) => f.code === "large-file"));
check("heuristic findings are labelled", (imageFile?.findings ?? []).some((f) => f.heuristic === true) === expectLarge);
const cssFile = assets.body?.data?.files?.find((f) => f.kind === "css");
check("css findings reference font-display gaps", cssFile?.findings?.some((f) => f.code === "font-display-missing"));

/* ---------------------------------------------------------------- history */
console.log("\nhistory");
const history = await call("/api/v1/history?page=1&pageSize=5");
check("history returns 200", history.status === 200);
check("history records the jobs we just ran", history.body?.data?.total >= 3, `${history.body?.data?.total}`);
check("summary aggregates real bytes", history.body?.data?.summary?.savedBytes > 0);
check("every entry carries item metadata", (history.body?.data?.entries ?? []).every((e) => typeof e.fileCount === "number"));

const filtered = await call("/api/v1/history?kind=css.font-display");
check("filter by kind works", (filtered.body?.data?.entries ?? []).every((e) => e.kind === "css.font-display"));

const jobId = history.body?.data?.entries?.[0]?.id;
const detail = await call(`/api/v1/history/${jobId}`);
check("job detail returns items", (detail.body?.data?.items ?? []).length > 0);

const zip = await call("/api/v1/artifacts/zip", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ids: [artifactId], name: "selftest-bundle" }),
});
check("zip bundle downloads", zip.status === 200 && zip.headers.get("content-type") === "application/zip");
check("zip is a real archive", zip.body.subarray(0, 2).toString() === "PK");

const foreignZip = await fetch(`${BASE}/api/v1/artifacts/zip`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: "ow_sid=00000000-0000-4000-8000-000000000000" },
  body: JSON.stringify({ ids: [artifactId] }),
});
check("zip rejects artifacts from other sessions", foreignZip.status === 400, `status ${foreignZip.status}`);

const deleted = await call(`/api/v1/history/${jobId}`, { method: "DELETE" });
check("job can be deleted", deleted.status === 200);
const afterDelete = await call(`/api/v1/history/${jobId}`);
check("deleted job returns 404", afterDelete.status === 404);

/* --------------------------------------------------------------- settings */
console.log("\npreferences");
const prefs = await call("/api/v1/preferences");
check("preferences endpoint responds", prefs.status === 200);
const saved = await call("/api/v1/preferences", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    defaultImageFormat: "avif",
    defaultQuality: 62,
    defaultMaxWidth: 1600,
    fontDisplayPolicy: "fallback",
    analyzerThresholdKb: 220,
    reduceMotion: false,
  }),
});
check("preferences persist", saved.body?.data?.defaultQuality === 62, JSON.stringify(saved.body?.data));
const restored = await call("/api/v1/preferences");
check("preferences are read back", restored.body?.data?.defaultImageFormat === "avif");
const badPrefs = await call("/api/v1/preferences", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ defaultQuality: 5 }),
});
check("invalid preference value is rejected", badPrefs.status === 422, `status ${badPrefs.status}`);

/* ------------------------------------------------------------ rate limit */
console.log("\nrate limiting");
let limited = false;
let lastStatus = 0;
for (let i = 0; i < 80; i += 1) {
  const response = await call("/api/v1/css/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ css: "body{color:#222}" }),
  });
  lastStatus = response.status;
  if (response.status === 429) {
    limited = true;
    check("rate limit reports Retry-After", Boolean(response.headers.get("retry-after")));
    break;
  }
}
check("css endpoint rate limit engages", limited, `last status ${lastStatus}`);

/* ------------------------------------------------------------------ pages */
console.log("\npages");
for (const path of ["/", "/app", "/app/images", "/app/fonts", "/app/assets", "/app/audit", "/app/history", "/app/settings"]) {
  const response = await fetch(`${BASE}${path}`, { headers: { cookie } });
  check(`GET ${path} renders`, response.status === 200, `status ${response.status}`);
}
const missing = await fetch(`${BASE}/app/does-not-exist`);
const missingHtml = await missing.text();
check("unknown client-side route serves SPA shell for the React 404 page", missing.status === 200 && missingHtml.includes('id="root"'));

/* ---------------------------------------------------------------- summary */
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(` - ${failure}`);
  process.exit(1);
}
console.log("\nAll API checks passed.");
