#!/usr/bin/env node
/**
 * Self-test of the Image Optimizer screen in a DOM. Needs no browser.
 *
 *   npm run test:dom
 *
 * It mounts the real screen in jsdom and uses it the way a person does: choose
 * files, press "Optimize", keep an original, download, cancel, start over.
 *
 * Real in this test: the screen, the check of each file's contents before
 * decoding, the planning, the selection, the numbers, the downloads and the
 * ZIP. Replaced: the engine, because jsdom has no image decoder or encoder.
 * The stand-in hands back files of known sizes and contents, so every number
 * the screen shows can be checked against the bytes behind it.
 *
 * Every API that could send data (fetch, XMLHttpRequest, sendBeacon,
 * WebSocket, EventSource) is replaced by a recorder. The test fails if the
 * screen touches one of them.
 */
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import JSZip from "jszip";
import { createDom, createModuleLoader } from "./lib/dom-kit.mjs";
import { createChecker, fixture, pngDeclaring, solidPng } from "./lib/selftest-kit.mjs";

const { check, section, report, crashed } = createChecker("optimizer-dom-selftest");
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

const dom = createDom();
const { document, tap, waitFor, text, chooseFiles, setValue, downloads } = dom;
const loader = await createModuleLoader();
const { mountImageOptimizer } = await loader.load("/scripts/lib/mount-image-optimizer.tsx");
const plan = await loader.load("/src/features/images/engine/plan.ts");
const { formatBytes } = await loader.load("/src/lib/format.ts");

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const bytesOf = async (blob) => Buffer.from(await blob.arrayBuffer());

/* ---------------------------------------------------------------- the files */
const photoBytes = fixture("photo-800x600.jpg");
const flatBytes = fixture("flat-600x400.png");
const alphaBytes = fixture("alpha-320x200.png");
const file = (name, data, type = "") => new File([data], name, { type, lastModified: 1_700_000_000_000 });
const photo = file("photo-800x600.jpg", photoBytes, "image/jpeg");
const flat = file("flat-600x400.png", flatBytes, "image/png");
const alpha = file("alpha-320x200.png", alphaBytes, "image/png");
const fake = file("notes.jpg", Buffer.from("meeting notes, not an image\n".repeat(8)), "image/jpeg");
const spinner = file("spinner.gif", fixture("animated-3f-60x40.gif"), "image/gif");
const bomb = file("bomb.png", pngDeclaring(30_000, 30_000), "image/png");

/** Sizes the stand-in encoder returns: per file and format, in bytes. */
const ENCODED = {
  "photo-800x600.jpg": { webp: 90_174, avif: 128_079, jpeg: 68_866, png: 854_307 },
  "flat-600x400.png": { webp: 1_438, avif: 700, jpeg: 4_994, png: 690 },
  "alpha-320x200.png": { webp: 5_512, avif: 2_536, jpeg: 9_001, png: 60_000 },
};
const TRANSPARENT = new Set(["alpha-320x200.png"]);
const encodedBytes = (name, format) => {
  const size = ENCODED[name]?.[format] ?? 1_000;
  // Contents that differ per file and format, so that a mixed-up download would show.
  return Buffer.alloc(size, sha256(`${name}:${format}`).slice(0, 2), "hex");
};

/* ------------------------------------------------------- the stand-in engine */
const engineLog = { jobs: [], cancels: 0, disposals: 0 };
let held = [];
let mode = "auto";
let failing = new Map();
function answer({ job, events }) {
  const { request } = job;
  const name = [photo, flat, alpha].find((candidate) => candidate === request.file)?.name ?? "other";
  const failure = failing.get(name);
  if (failure) {
    events.failed(request.id, { id: request.id, ...failure });
    return;
  }
  const size = plan.targetSize(request.source.width, request.source.height, request.maxWidth, request.maxHeight);
  const transparent = TRANSPARENT.has(name);
  events.stage(request.id, "decoding");
  events.done(request.id, {
    id: request.id,
    decodedWidth: request.source.width,
    decodedHeight: request.source.height,
    outputWidth: size.width,
    outputHeight: size.height,
    resized: size.resized,
    usesTransparency: request.source.mayHaveAlpha ? transparent : null,
    flattened: false,
    candidates: request.candidates.map((candidate) => {
      const skipped = candidate.requiresOpaque && transparent;
      return {
        format: candidate.format,
        quality: candidate.quality,
        note: candidate.note,
        blob: skipped ? null : new Blob([encodedBytes(name, candidate.format)], { type: plan.OUTPUT_MIME[candidate.format] }),
        problem: skipped ? "not tried: the image uses transparency, which JPEG cannot store" : null,
        encoder: skipped ? null : candidate.format === "avif" ? "wasm" : "browser",
        ms: 4,
      };
    }),
    decodeMs: 2,
  });
}
const engine = {
  submit(jobs, events) {
    for (const job of jobs) {
      engineLog.jobs.push(job);
      held.push({ job, events });
    }
    if (mode === "auto") setTimeout(() => { for (const entry of held.splice(0)) answer(entry); }, 5);
  },
  cancelAll() {
    engineLog.cancels += 1;
    for (const { job, events } of held.splice(0)) events.failed(job.request.id, { id: job.request.id, code: "cancelled", message: "Cancelled before it finished.", hint: "" });
  },
  busy: () => held.length > 0,
  dispose() {
    engineLog.disposals += 1;
  },
};

const limits = { ...plan.resolveEngineLimits({ deviceMemory: 8, cores: 8 }), maxFiles: 7 };
const root = mountImageOptimizer(document.getElementById("root"), { engine, limits });

/* ------------------------------------------------------------------ helpers */
const queueRows = () => Array.from(document.querySelectorAll('[data-testid="queue"] > li')).map((row) => ({ status: row.getAttribute("data-status"), text: text(row), name: row.querySelector("p[title]")?.getAttribute("title") }));
const rowOf = (name) => queueRows().find((row) => row.name === name);
const resultRows = () => Array.from(document.querySelectorAll('[data-testid="results"] > tr')).map((row) => {
  const cells = Array.from(row.querySelectorAll("td")).map((cell) => text(cell));
  return { kind: row.getAttribute("data-result"), name: row.querySelector("td span[title]")?.getAttribute("title"), output: cells[0], before: cells[1], after: cells[2], saved: cells[3], dimensions: cells[4], format: cells[5] };
});
const resultOf = (name) => resultRows().find((row) => row.name === name);
const settled = () => waitFor(() => document.querySelectorAll('[data-testid="queue"] > li[data-status="checking"]').length === 0);
const idle = () => waitFor(() => !document.querySelector('[data-testid="progress"]') && !queueRows().some((row) => row.status === "waiting" || row.status === "processing"));
const optimizeLabel = () => dom.buttonLabels().find((label) => /^Optimize/.test(label)) ?? null;
const metric = (label) => {
  const term = Array.from(document.querySelectorAll('[data-testid="review"] dt, [data-testid="review"] p, [data-testid="review"] span')).find((node) => text(node) === label);
  return term ? text(term.parentElement) : "";
};
const lastDownload = () => downloads.at(-1);
/** Presses "Optimize N files", waits until the engine has the jobs and until the run is over. Returns the jobs of this run. */
async function optimize(count) {
  const before = engineLog.jobs.length;
  const pressed = await tap(`Optimize ${count} file${count === 1 ? "" : "s"}`);
  if (!pressed) throw new Error(`"Optimize ${count} file${count === 1 ? "" : "s"}" was not offered; the button says "${optimizeLabel()}"`);
  await waitFor(() => engineLog.jobs.length === before + count);
  await idle();
  return engineLog.jobs.slice(before);
}

/* ============================================================== selection */
section("selecting files: each one is checked from its contents, before anything is decoded");
check("the screen renders with an empty queue and nothing to optimize", await waitFor(() => optimizeLabel() === "Optimize") && document.querySelector('[data-testid="queue"]') === null && dom.findButton("Optimize").disabled === true);
chooseFiles([photo, flat, alpha, fake, spinner, bomb]);
await settled();
{
  const rows = queueRows();
  check("six files are listed", rows.length === 6, rows.map((row) => `${row.name}=${row.status}`).join(" "));
  check("the three images are ready, with format, size and dimensions read from their headers", ["photo-800x600.jpg", "flat-600x400.png", "alpha-320x200.png"].every((name) => rowOf(name)?.status === "ready") && /JPEG · 160\.7 KB · 800 × 600/.test(rowOf("photo-800x600.jpg").text) && /PNG · 670 B · 600 × 400/.test(rowOf("flat-600x400.png").text), rows.map((row) => row.text).join(" | "));
  check("a text file named .jpg is not accepted: the name is not trusted", rowOf("notes.jpg")?.status === "not accepted" && /not an image format/.test(rowOf("notes.jpg").text));
  check("an animated GIF is not accepted, and the row says why and what to do", rowOf("spinner.gif")?.status === "not accepted" && /animated \(3 frames\)/.test(rowOf("spinner.gif").text) && /video/.test(rowOf("spinner.gif").text));
  check("a PNG that declares 30,000 × 30,000 px is not accepted, from its header alone", rowOf("bomb.png")?.status === "not accepted" && /30,000 × 30,000 px \(900 MP\)/.test(rowOf("bomb.png").text));
  const total = photo.size + flat.size + alpha.size + fake.size + spinner.size + bomb.size;
  check("the queue total is the sum of the files' real sizes", text(document.querySelector('[data-testid="queue-total"]')) === `6 files · ${formatBytes(total)} · 3 not accepted`, text(document.querySelector('[data-testid="queue-total"]')));
  check("the button counts only the files that were accepted", optimizeLabel() === "Optimize 3 files", String(optimizeLabel()));
  check("checking the files started no processing", engineLog.jobs.length === 0);
}
chooseFiles([photo]);
await settled();
check("a file that is already in the queue is not added twice", queueRows().length === 6 && /1 file not added/.test(text()) && /already in the queue/.test(text()));
chooseFiles([file("one-more.png", solidPng(10, 10)), file("too-many.png", solidPng(12, 12))]);
await settled();
check("the queue takes at most the configured number of files, and says what was left out", queueRows().length === 7 && rowOf("too-many.png") === undefined && /beyond 7 files in one queue/.test(text()), `${queueRows().length} rows`);
await tap("Remove one-more.png");
await waitFor(() => queueRows().length === 6);
check("a file can be removed from the queue", rowOf("one-more.png") === undefined && optimizeLabel() === "Optimize 3 files");

/* ==================================================================== run */
section("optimizing: the files go to the engine in this tab, with the planned work");
mode = "manual";
await tap("Optimize 3 files");
await waitFor(() => engineLog.jobs.length === 3);
{
  const jobs = engineLog.jobs;
  check("the engine receives the selected File objects themselves", jobs[0].request.file === photo && jobs[1].request.file === flat && jobs[2].request.file === alpha);
  check("single WebP at quality 78: one candidate per file", jobs.every((job) => job.request.candidates.length === 1 && job.request.candidates[0].format === "webp" && job.request.candidates[0].quality === 78));
  check("each job states its pixels and a time limit, which is what the scheduler bounds", jobs[0].pixels === 480_000 && jobs[1].pixels === 240_000 && jobs.every((job) => job.timeoutMs >= 30_000));
  check("the refused files were not sent to the engine", !jobs.some((job) => [fake, spinner, bomb].includes(job.request.file)));
  check("while it runs, progress is shown and Cancel is offered", document.querySelector('[data-testid="progress"]') !== null && dom.findButton("Cancel") !== null && dom.findButton("Processing…")?.disabled === true);
  check("files cannot be removed in the middle of a run", dom.findButton("Remove photo-800x600.jpg") === null);
  held[0].events.stage(held[0].job.request.id, "encoding", "WebP");
  await waitFor(() => rowOf("photo-800x600.jpg")?.status === "processing");
  check("the row shows what the engine is doing with the file", /encoding WebP/.test(rowOf("photo-800x600.jpg").text) && rowOf("flat-600x400.png").status === "waiting");
}
for (const entry of held.splice(0)) answer(entry);
await idle();
mode = "auto";

section("results: every number is the size of a real file");
{
  const row = resultOf("photo-800x600.jpg");
  check("three files have a result", resultRows().length === 3 && queueRows().filter((entry) => entry.status === "done").length === 3);
  check("Before is the selected file's size", row.before === "160.7 KB" && photo.size === 164_543, JSON.stringify(row));
  check("After is the encoded file's size", row.after === "88.1 KB" && formatBytes(90_174) === "88.1 KB");
  check("Saved is computed from those two", row.saved === "+45.2%" && row.kind === "smaller");
  check("the output's name, size in pixels and format are shown", /photo-800x600-optimized\.webp/.test(row.output) && row.dimensions === "800 × 600" && row.format === "WebP");
  const input = photo.size + flat.size + alpha.size;
  const output = 90_174 + 1_438 + 5_512;
  check("the totals are the sums of those sizes", metric("Input").includes(formatBytes(input)) && metric("Output").includes(formatBytes(output)) && metric("Saved").includes(formatBytes(input - output)), `${metric("Input")} | ${metric("Output")} | ${metric("Saved")}`);
  check("the summary message names the tab as the place of processing", /3 files processed in this tab/.test(text()));
}

section("a result that is larger than its original");
{
  const row = resultOf("flat-600x400.png");
  check("the growth is shown as it is: 670 B became 1.4 KB, −114.6%", row.kind === "larger" && row.before === "670 B" && row.after === "1.4 KB" && row.saved === "-114.6%", JSON.stringify(row));
  check("a notice explains it and names the remedy", /1 result is larger than the original/.test(text()) && /No-regression/.test(text()));
  check("the queue row says so too", /114\.6% larger/.test(rowOf("flat-600x400.png").text), rowOf("flat-600x400.png").text);
  check("the original is offered for that file, and only for that file", dom.findButton("Keep the original for flat-600x400.png") !== null && dom.findButton("Keep the original for photo-800x600.jpg") === null);
  await tap("Download flat-600x400-optimized.webp");
  check("before choosing, the download is the converted file", lastDownload()?.name === "flat-600x400-optimized.webp" && lastDownload().blob?.size === 1_438);
  await tap("Keep the original for flat-600x400.png");
  await waitFor(() => resultOf("flat-600x400.png")?.kind === "original");
  const kept = resultOf("flat-600x400.png");
  check("after \"Keep original\" the row shows the original: 670 B, 0%, PNG", kept.after === "670 B" && kept.saved === "0%" && kept.format === "PNG" && /original kept/.test(kept.output), JSON.stringify(kept));
  await tap("Download flat-600x400.png");
  check("the download is then the selected file, byte for byte, under its own name", lastDownload()?.name === "flat-600x400.png" && sha256(await bytesOf(lastDownload().blob)) === sha256(flatBytes));
  check("the totals follow the choice", metric("Output").includes(formatBytes(90_174 + 670 + 5_512)) && !/is larger than the original/.test(text()), metric("Output"));
  check("the choice can be undone", dom.findButton("Use the converted file for flat-600x400.png") !== null);
}

section("downloads come from this tab's memory");
{
  await tap("Download photo-800x600-optimized.webp");
  const saved = lastDownload();
  check("a download is a blob: URL, which the browser resolves without a request", saved.href.startsWith("blob:") && saved.name === "photo-800x600-optimized.webp");
  check("the saved file is the engine's output, byte for byte", saved.blob.size === 90_174 && sha256(await bytesOf(saved.blob)) === sha256(encodedBytes("photo-800x600.jpg", "webp")));
  const before = downloads.length;
  await tap("Download all (ZIP)");
  await waitFor(() => downloads.length > before);
  const archive = lastDownload();
  check("\"Download all\" saves one ZIP, named after the product, also from a blob: URL", archive?.name === "unikit-images.zip" && archive.href.startsWith("blob:") && archive.blob?.type === "application/zip");
  const zip = await JSZip.loadAsync(await bytesOf(archive.blob));
  const names = Object.keys(zip.files).sort();
  check("the ZIP holds what is offered for each file: two converted files and the kept original", names.join() === "alpha-320x200-optimized.webp,flat-600x400.png,photo-800x600-optimized.webp", names.join());
  const entry = async (name) => sha256(await zip.file(name).async("nodebuffer"));
  check("every entry is byte for byte the file a single download gives", (await entry("photo-800x600-optimized.webp")) === sha256(encodedBytes("photo-800x600.jpg", "webp")) && (await entry("flat-600x400.png")) === sha256(flatBytes) && (await entry("alpha-320x200-optimized.webp")) === sha256(encodedBytes("alpha-320x200.png", "webp")));
  check("the message says where the ZIP was made", /ZIP created in this tab/.test(text()));
}

/* ============================================================= strategies */
section("strategies");
await tap("No-regression");
await waitFor(() => /3 results will be made again/.test(text()));
check("changing the strategy marks the results as out of date and offers to make them again", optimizeLabel() === "Optimize 3 files");
{
  const jobs = await optimize(3);
  check("no-regression asks for WebP, AVIF and JPEG, with JPEG only for opaque images", jobs.every((job) => job.request.candidates.map((candidate) => `${candidate.format}${candidate.requiresOpaque ? "?" : ""}`).join() === "webp,avif,jpeg?"), JSON.stringify(jobs[0].request.candidates));
  check("the photo gets the smallest of the three: the 67.3 KB JPEG", resultOf("photo-800x600.jpg").after === "67.3 KB" && resultOf("photo-800x600.jpg").format === "JPEG" && /-optimized\.jpg/.test(resultOf("photo-800x600.jpg").output), JSON.stringify(resultOf("photo-800x600.jpg")));
  check("the transparent image gets AVIF; JPEG was left out for it, and the card says why", resultOf("alpha-320x200.png").format === "AVIF" && resultOf("alpha-320x200.png").after === "2.5 KB" && /transparency, which JPEG cannot store/.test(text()));
  const kept = resultOf("flat-600x400.png");
  check("the flat graphic, which every format makes larger, keeps its original by itself", kept.kind === "original" && kept.after === "670 B" && kept.saved === "0%", JSON.stringify(kept));
  check("the reason is stated", /Every result was at least as large as the original, so the original file is kept\./.test(text()));
  check("no result is larger than its original", resultRows().every((row) => row.kind !== "larger") && !/is larger than the original/.test(text()));
  await tap("Download flat-600x400.png");
  check("its download is the selected file, byte for byte", sha256(await bytesOf(lastDownload().blob)) === sha256(flatBytes));
  check("the compared formats are listed with their real sizes", /Formats compared/i.test(text()) && text().includes(formatBytes(128_079)) && text().includes(formatBytes(90_174)));
}
await tap("Best-effort");
await optimize(3);
check("best-effort keeps the smallest format even when it is larger than the original, and says so", resultOf("flat-600x400.png").kind === "larger" && resultOf("flat-600x400.png").after === "700 B" && resultOf("flat-600x400.png").format === "AVIF" && /1 result is larger than the original/.test(text()), JSON.stringify(resultOf("flat-600x400.png")));

/* ============================================================ size limits */
section("size limits and settings reach the engine as chosen");
await tap("Single");
await tap("JPEG");
await tap("Size limits");
await waitFor(() => document.querySelector("#maxWidth") !== null);
setValue("#maxWidth", "200");
setValue("#quality", "61");
{
  const jobs = await optimize(3);
  check("max width 200 and JPEG at quality 61 are what the engine is asked for", jobs.every((job) => job.request.maxWidth === 200 && job.request.maxHeight === null && job.request.candidates.length === 1 && job.request.candidates[0].format === "jpeg" && job.request.candidates[0].quality === 61), JSON.stringify(jobs[0].request.candidates));
  check("the table shows the output's size: 200 × 150 for the 800 × 600 photo", resultOf("photo-800x600.jpg").dimensions === "200 × 150" && resultOf("flat-600x400.png").dimensions === "200 × 133", JSON.stringify(resultRows().map((row) => row.dimensions)));
  setValue("#maxWidth", "abc5xyz");
  await waitFor(() => document.querySelector("#maxWidth").value === "5");
  check("only digits are accepted in a size field", document.querySelector("#maxWidth").value === "5");
  const tiny = await optimize(3);
  check("a limit below the minimum is raised to 16 px before it is used", tiny.every((job) => job.request.maxWidth === 16));
  setValue("#maxWidth", "");
  await tap("Keep format");
  const same = await optimize(3);
  check("\"Keep format\" asks for each file's own format", same.map((job) => job.request.candidates[0].format).join() === "jpeg,png,png" && same.every((job) => job.request.maxWidth === null));
}

/* ================================================================ failure */
section("one file that fails does not affect the others");
await tap("WebP");
failing = new Map([["alpha-320x200.png", { code: "decode_failed", message: "This browser could not decode the PNG file.", hint: "The file may be damaged. Export it again from the source." }]]);
await optimize(3);
{
  check("the failed file is marked failed, with the reason and a next step in its row", rowOf("alpha-320x200.png").status === "failed" && /could not decode the PNG file/.test(rowOf("alpha-320x200.png").text) && /Export it again/.test(rowOf("alpha-320x200.png").text));
  check("it is listed under the files without a result", /could not decode the PNG file/.test(text(document.querySelector('[data-testid="unfinished"]'))));
  check("the other two files have their results", resultRows().length === 2 && resultOf("photo-800x600.jpg").after === "88.1 KB");
  check("the totals count only the files with a result", metric("Input").includes(formatBytes(photo.size + flat.size)) && metric("Not finished").includes("1"), `${metric("Input")} | ${metric("Not finished")}`);
  check("only the failed file is offered for another run", optimizeLabel() === "Optimize 1 file");
  failing = new Map();
  const again = await optimize(1);
  check("running again processes just that file, and it then has a result", again[0].request.file === alpha && resultRows().length === 3 && document.querySelector('[data-testid="unfinished"]') === null);
}

/* ================================================================= cancel */
section("cancelling");
await tap("AVIF");
mode = "manual";
await tap("Optimize 3 files");
await waitFor(() => held.length === 3);
answer(held.shift());
await waitFor(() => rowOf("photo-800x600.jpg")?.status === "done" && resultOf("photo-800x600.jpg")?.format === "AVIF");
const cancelsBefore = engineLog.cancels;
await tap("Cancel");
await idle();
mode = "auto";
{
  check("Cancel tells the engine to stop everything", engineLog.cancels === cancelsBefore + 1);
  check("the file that had finished keeps its result", rowOf("photo-800x600.jpg").status === "done" && resultOf("photo-800x600.jpg").format === "AVIF" && resultOf("photo-800x600.jpg").after === formatBytes(128_079));
  check("the other two are marked cancelled, not failed", rowOf("flat-600x400.png").status === "cancelled" && rowOf("alpha-320x200.png").status === "cancelled");
  check("they are listed as stopped, and offered for another run", /Stopped before it finished/.test(text(document.querySelector('[data-testid="unfinished"]'))) && optimizeLabel() === "Optimize 2 files");
  check("the results of earlier runs for those two files are gone: no stale download is offered", resultRows().length === 1);
}

/* ================================================================ cleanup */
section("nothing is left behind");
{
  check("previews of the results are blob: URLs held by the page", dom.liveUrls.size > 0 && document.querySelectorAll("img").length >= 2 && Array.from(document.querySelectorAll("img")).every((image) => image.getAttribute("src").startsWith("blob:")), `${dom.liveUrls.size} live`);
  check("every image has a text alternative", Array.from(document.querySelectorAll("img")).every((image) => (image.getAttribute("alt") ?? "").length > 0));
  await tap("Start over");
  await waitFor(() => document.querySelector('[data-testid="queue"]') === null);
  await sleep(30);
  check("\"Start over\" empties the queue and the results", document.querySelector('[data-testid="review"]') === null && optimizeLabel() === "Optimize");
  check(`and releases every blob: URL (${dom.urlsCreated()} were created during the test)`, dom.liveUrls.size === 0, Array.from(dom.liveUrls).join(" "));
  chooseFiles([photo]);
  await waitFor(() => queueRows().length === 1);
  await settled();
  await tap("WebP");
  await optimize(1);
  await waitFor(() => dom.liveUrls.size > 0);
  const disposalsBefore = engineLog.disposals;
  root.unmount();
  await sleep(30);
  check("leaving the page disposes the engine, which is what terminates its workers", engineLog.disposals === disposalsBefore + 1);
  check("and releases the blob: URLs of the results that were on screen", dom.liveUrls.size === 0, `${dom.liveUrls.size} live`);
  check("the screen never called an API that sends data", dom.network.length === 0, JSON.stringify(dom.network));
  check("no script error was raised", dom.pageErrors.length === 0, dom.pageErrors.join(" | "));
}

await loader.close();
const ok = report();
if (ok) console.log("\nAll Image Optimizer screen checks passed.");
process.exit(ok ? 0 : 1);
