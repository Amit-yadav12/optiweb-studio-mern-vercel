#!/usr/bin/env node
/**
 * Capacity benchmark for the direct-upload pipeline, with the default limits
 * (25 MB per file, 10 files and 150 MB per job, 40 MP per image).
 *
 *   npm run bench:capacity
 *
 * Sample files are generated first, in a process of their own, and written to
 * a temporary directory: photo-like JPEGs (a colour gradient with sensor-like
 * noise) padded with ignorable metadata segments to an exact size, so "25 MB"
 * means exactly 26,214,400 bytes.
 *
 * Each scenario then runs in a fresh process, so its peak memory is its own
 * and does not include generating the samples. A scenario drives the real
 * pipeline through the HTTP API: create a job, send the files to storage,
 * confirm them, let the worker run, download the results.
 *
 * What the numbers are, and are not: they are measured on the machine that
 * runs this script, with storage on local disk. Upload and download times are
 * loopback times and say nothing about a real network. Processing time and
 * memory depend on the CPU and are the numbers that matter for sizing a
 * function. They are not measurements of the deployed runtime.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const MB = 1024 * 1024;
const scenarioArg = process.argv.indexOf("--scenario");
const prepareArg = process.argv.indexOf("--prepare");
/** Directory of the generated sample files. */
const sampleDir = process.env.OW_BENCH_SAMPLES ?? "";
const sample = (name) => fs.readFileSync(path.join(sampleDir, name));

/** The sample files every scenario reads. Written once, by `--prepare`. */
async function prepareSamples(dir) {
  const write = (name, data) => fs.writeFileSync(path.join(dir, name), data);
  const sized = { "1mb.jpg": [1, 1800, 1200], "5mb.jpg": [5, 3600, 2400], "10mb.jpg": [10, 4200, 2800], "20mb.jpg": [20, 5400, 3600], "25mb.jpg": [25, 7200, 5400], "25mb-24mp.jpg": [25, 6000, 4000], "1mb-small.jpg": [1, 1500, 1000], "5mb-6mp.jpg": [5, 3000, 2000] };
  for (const [name, spec] of Object.entries(sized)) write(name, await photoOfSize(...spec));
  write("40mp.jpg", await photo(7300, 5475, 90, 18));
  write("16mp.jpg", await photo(4800, 3200, 88));
  write("small.jpg", await photo(1200, 800));
  write("alpha-12mp.png", await transparentPng(4000, 3000));
  write("bomb.png", await bombPng());
}
const SCENARIOS = ["single-1mb", "single-5mb", "single-10mb", "single-20mb", "single-25mb", "large-40mp", "transparent-12mp", "avif-16mp", "batch-10", "concurrent-2-jobs", "invalid"];

/* ------------------------------------------------------------- sample files */

/** A photo-like JPEG of the given dimensions. */
async function photo(width, height, quality = 88, sigma = 16) {
  const gradient = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 40, g: 110, b: 200 } } })
    .composite([{ input: Buffer.from('<svg width="64" height="64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4c542"/><stop offset="1" stop-color="#1b3a6b"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/></svg>') }])
    .resize(width, height, { kernel: "cubic" })
    .raw()
    .toBuffer();
  return sharp({ create: { width, height, channels: 3, noise: { type: "gaussian", mean: 128, sigma } } })
    .composite([{ input: gradient, raw: { width, height, channels: 3 }, blend: "soft-light" }])
    .jpeg({ quality })
    .toBuffer();
}

/** Pads a JPEG to exactly `bytes` with application segments, which every decoder skips. */
function padJpeg(jpeg, bytes) {
  let missing = bytes - jpeg.length;
  if (missing < 0) throw new Error(`sample is ${jpeg.length} bytes, larger than the ${bytes} byte target`);
  const segments = [];
  while (missing > 0) {
    // A segment is a 2-byte marker, a 2-byte length (which counts itself) and its data.
    const size = Math.min(missing, 65_535 + 2);
    if (size < 4) throw new Error("cannot pad by fewer than 4 bytes");
    const take = missing - size > 0 && missing - size < 4 ? size - 4 : size;
    const segment = Buffer.alloc(take, 0x20);
    segment[0] = 0xff;
    segment[1] = 0xef;
    segment.writeUInt16BE(take - 2, 2);
    segments.push(segment);
    missing -= take;
  }
  return Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}

/** A JPEG of exactly `megabytes` MB with the given pixel count. */
async function photoOfSize(megabytes, width, height) {
  const target = Math.round(megabytes * MB);
  // Start at a quality that lands below the target, then pad up to it exactly.
  for (const quality of [90, 80, 70, 55, 40]) {
    const base = await photo(width, height, quality);
    if (base.length <= target - 4) return padJpeg(base, target);
  }
  throw new Error(`cannot make a ${megabytes} MB JPEG at ${width}x${height}`);
}

/** A PNG with real transparency. */
async function transparentPng(width, height) {
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="g"><stop offset="0" stop-color="#e2452f" stop-opacity="1"/><stop offset="1" stop-color="#1b3a6b" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 6 }).toBuffer();
}

/** A tiny PNG whose header claims 30,000 × 30,000 pixels: 900 MP from about 100 bytes. */
async function bombPng() {
  const { crc32 } = await import("node:zlib");
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(30_000, 0);
  header.writeUInt32BE(30_000, 4);
  header[8] = 8;
  header[9] = 2;
  const { deflateSync } = await import("node:zlib");
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(64))), chunk("IEND", Buffer.alloc(0))]);
}

/* ------------------------------------------------------------------ a child */

async function runScenario(name) {
  const { preparePipelineEnvironment } = await import("./lib/pipeline-kit.mjs");
  const { startApi } = await import("./lib/selftest-kit.mjs");
  const env = await preparePipelineEnvironment({ OW_JOB_TRIGGER: "manual" });
  const api = await startApi();
  const { drainJobs } = await import("../src/server/pipeline/worker.ts");
  const { resetRateLimits } = await import("../src/server/middleware/rateLimit.ts");

  const ms = (from) => Math.round(performance.now() - from);
  const json = (cookie, pathname, body) => api.call(pathname, { cookie, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  async function session() {
    return (await api.call("/api/v1/session")).sessionCookie;
  }
  /** Runs one job end to end and times each stage. */
  async function job(cookie, files, settings, { drain = true } = {}) {
    resetRateLimits();
    const timing = {};
    let mark = performance.now();
    const created = await json(cookie, "/api/v1/jobs/image-optimization", { files: files.map((file) => ({ name: file.name, type: file.type, size: file.data.length })), settings });
    if (created.status !== 201) return { refused: `${created.status} ${created.json?.error?.code}`, message: created.json?.error?.message };
    const items = created.json.data.job.items;
    mark = performance.now();
    for (const [index, item] of items.entries()) {
      const grant = (await json(cookie, "/api/v1/uploads/token", { uploadId: item.id })).json.data.upload;
      await fetch(`${api.base}${grant.uploadUrl}`, { method: "PUT", headers: { cookie, "content-type": grant.contentType }, body: files[index].data });
      await json(cookie, "/api/v1/uploads/complete", { uploadId: item.id });
    }
    timing.uploadMs = ms(mark);
    if (!drain) return { jobId: created.json.data.job.id, timing };
    mark = performance.now();
    const run = await drainJobs();
    timing.processMs = ms(mark);
    const done = (await api.call(`/api/v1/jobs/${created.json.data.job.id}`, { cookie })).json.data.job;
    mark = performance.now();
    let downloaded = 0;
    for (const item of done.items) {
      if (!item.artifactId) continue;
      const file = await api.call(`/api/v1/artifacts/${item.artifactId}`, { cookie });
      if (file.status === 200 && file.bytes.length === item.result.outputBytes) downloaded += 1;
    }
    timing.downloadMs = ms(mark);
    return {
      state: done.state,
      files: done.items.length,
      completed: done.counts.completed,
      failed: done.counts.failed,
      downloaded,
      retries: run.itemsRetried,
      inputMb: +(files.reduce((sum, file) => sum + file.data.length, 0) / MB).toFixed(2),
      outputMb: +(done.totals.outputBytes / MB).toFixed(2),
      transformMs: done.items.reduce((sum, item) => sum + (item.result?.durationMs ?? 0), 0),
      megapixels: +(done.items.reduce((sum, item) => sum + (item.result ? (item.result.inputWidth ?? 0) * (item.result.inputHeight ?? 0) : 0), 0) / 1e6).toFixed(1),
      errors: done.items.filter((item) => item.state === "failed").map((item) => item.errorCode),
      ...timing,
    };
  }

  const webp = { format: "webp", quality: 80 };
  const result = { scenario: name };
  const single = { "single-1mb": "1mb.jpg", "single-5mb": "5mb.jpg", "single-10mb": "10mb.jpg", "single-20mb": "20mb.jpg", "single-25mb": "25mb.jpg" }[name];
  if (single) {
    const data = sample(single);
    const cookie = await session();
    const file = { name: `${name}.jpg`, type: "image/jpeg", data };
    // The first run in a fresh process includes loading the image library; the second does not.
    result.cold = await job(cookie, [file], webp);
    result.warm = await job(cookie, [file], webp);
  } else if (name === "large-40mp") {
    const data = sample("40mp.jpg");
    const cookie = await session();
    result.webp = await job(cookie, [{ name: "40mp.jpg", type: "image/jpeg", data }], webp);
    result.jpeg = await job(cookie, [{ name: "40mp.jpg", type: "image/jpeg", data }], { format: "jpeg", quality: 80 });
    result.avifRefused = await job(cookie, [{ name: "40mp.jpg", type: "image/jpeg", data }], { format: "avif", quality: 60 });
  } else if (name === "transparent-12mp") {
    const data = sample("alpha-12mp.png");
    const cookie = await session();
    result.webp = await job(cookie, [{ name: "alpha.png", type: "image/png", data }], webp);
    const done = (await api.call("/api/v1/usage", { cookie })).json.data;
    result.storedMb = +(done.usedBytes / MB).toFixed(2);
  } else if (name === "avif-16mp") {
    const data = sample("16mp.jpg");
    const cookie = await session();
    result.avif = await job(cookie, [{ name: "16mp.jpg", type: "image/jpeg", data }], { format: "avif", quality: 60 });
  } else if (name === "batch-10") {
    // 25 + 20 + 2 × 10 + 3 × 5 + 3 × 1 = 83 MB, 89.5 MP in total.
    const names = ["25mb-24mp.jpg", "20mb.jpg", "10mb.jpg", "10mb.jpg", "5mb-6mp.jpg", "5mb-6mp.jpg", "5mb-6mp.jpg", "1mb-small.jpg", "1mb-small.jpg", "1mb-small.jpg"];
    const files = names.map((file, index) => ({ name: `batch-${index}.jpg`, type: "image/jpeg", data: sample(file) }));
    result.batch = await job(await session(), files, webp);
  } else if (name === "concurrent-2-jobs") {
    const data = sample("10mb.jpg");
    const files = [0, 1, 2].map((index) => ({ name: `c-${index}.jpg`, type: "image/jpeg", data }));
    const [a, b] = await Promise.all([session(), session()]);
    const [first, second] = await Promise.all([job(a, files, webp, { drain: false }), job(b, files, webp, { drain: false })]);
    const mark = performance.now();
    // Two worker runs at once, as two concurrent invocations in one instance would be.
    const runs = await Promise.all([drainJobs(), drainJobs()]);
    result.processMs = ms(mark);
    result.jobs = [first.jobId, second.jobId].length;
    result.itemsCompleted = runs.reduce((sum, run) => sum + run.itemsCompleted, 0);
    result.claimed = runs.map((run) => run.claimed);
    result.uploadMs = first.timing.uploadMs + second.timing.uploadMs;
  } else if (name === "invalid") {
    const valid = sample("small.jpg");
    const cookie = await session();
    const mark = performance.now();
    result.mixed = await job(cookie, [
      { name: "corrupt.jpg", type: "image/jpeg", data: Buffer.concat([valid.subarray(0, Math.floor(valid.length / 2))]) },
      { name: "bomb.png", type: "image/png", data: sample("bomb.png") },
      { name: "ok.jpg", type: "image/jpeg", data: valid },
    ], webp);
    result.totalMs = ms(mark);
    result.tooLarge = await job(cookie, [{ name: "over.jpg", type: "image/jpeg", data: Buffer.alloc(25 * MB + 1) }], webp);
    result.notAnImage = await job(cookie, [{ name: "text.png", type: "image/png", data: Buffer.alloc(5000, "not an image ") }], webp);
  }
  result.peakRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
  await api.close();
  await env.close();
  console.log(`RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

/* ----------------------------------------------------------------- the parent */

if (prepareArg >= 0) {
  await prepareSamples(process.argv[prepareArg + 1]);
  process.exit(0);
} else if (scenarioArg >= 0) {
  await runScenario(process.argv[scenarioArg + 1]);
} else {
  const only = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const selected = only.length > 0 ? SCENARIOS.filter((name) => only.includes(name)) : SCENARIOS;
  const lines = [];
  const say = (line = "") => { console.log(line); lines.push(line); };
  say(`Environment: ${os.cpus()[0]?.model ?? "unknown CPU"}, ${os.cpus().length} logical CPUs, ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB RAM, Node ${process.version}, sharp ${sharp.versions.sharp} (libvips ${sharp.versions.vips}).`);
  say(`Database: ${process.env.MONGODB_URI ? "MongoDB" : "in-memory stand-in"}. Storage: local disk. One image is processed at a time.`);
  say();
  say("| Scenario | Files | Input | Megapixels | Result | Transform | Whole job | Output | Peak memory |");
  say("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const row = (label, run, peak) => {
    if (!run) return;
    if (run.refused) return say(`| ${label} | – | – | – | refused at admission: ${run.refused} | – | – | – | ${peak} MB |`);
    say(`| ${label} | ${run.files} | ${run.inputMb} MB | ${run.megapixels} MP | ${run.state}${run.failed ? ` (${run.errors.join(", ")})` : ""}${run.retries ? `, ${run.retries} retries` : ""} | ${(run.transformMs / 1000).toFixed(1)} s | ${(run.processMs / 1000).toFixed(1)} s | ${run.outputMb} MB | ${peak} MB |`);
  };
  let failed = false;
  const samples = fs.mkdtempSync(path.join(os.tmpdir(), "optiweb-bench-"));
  const self = fileURLToPath(import.meta.url);
  const prepared = spawnSync(process.execPath, ["--import", "tsx", self, "--prepare", samples], { encoding: "utf8", timeout: 900_000 });
  if (prepared.status !== 0) {
    console.error(`sample generation failed: ${prepared.stderr.slice(-400)}`);
    process.exit(1);
  }
  for (const name of selected) {
    const child = spawnSync(process.execPath, ["--import", "tsx", self, "--scenario", name], { encoding: "utf8", maxBuffer: 64 * MB, timeout: 900_000, env: { ...process.env, OW_BENCH_SAMPLES: samples } });
    const line = child.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
    if (!line) {
      failed = true;
      say(`| ${name} | – | – | – | did not finish (exit ${child.status ?? child.signal}) | – | – | – | – |`);
      continue;
    }
    const result = JSON.parse(line.slice(7));
    const peak = result.peakRssMb;
    if (result.cold) {
      row(`${name}, cold`, result.cold, peak);
      row(`${name}, warm`, result.warm, peak);
    }
    row("40 MP JPEG → WebP", result.webp && name === "large-40mp" ? result.webp : null, peak);
    row("40 MP JPEG → JPEG", result.jpeg, peak);
    row("40 MP JPEG → AVIF", result.avifRefused, peak);
    row("12 MP transparent PNG → WebP", name === "transparent-12mp" ? result.webp : null, peak);
    row("16 MP JPEG → AVIF", result.avif, peak);
    row("10 mixed files, one job", result.batch, peak);
    if (name === "concurrent-2-jobs") say(`| two jobs at once, 3 × 10 MB each | 6 | 60 MB | – | ${result.itemsCompleted} of 6 converted; claims per worker run: ${result.claimed.join(" and ")} | – | ${(result.processMs / 1000).toFixed(1)} s | – | ${peak} MB |`);
    if (name === "invalid") {
      row("corrupt + 900 MP header + valid", result.mixed, peak);
      row("file above 25 MB", result.tooLarge, peak);
      row("text sent as PNG", result.notAnImage, peak);
    }
  }
  fs.rmSync(samples, { recursive: true, force: true });
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::notice title=capacity-benchmark::${lines.join("%0A")}`);
  process.exit(failed ? 1 : 0);
}
