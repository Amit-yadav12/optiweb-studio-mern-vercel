#!/usr/bin/env node
/**
 * Self-test of what the Image Optimizer shows about a result. Needs no browser.
 *
 *   npm run test:ui
 *
 * Every number on the results screen is derived in `src/features/images/model.ts`
 * from two measured things: the size of the selected file (`File.size`) and the
 * size of the file the browser encoded (`Blob.size`). This test builds results
 * from real `File` and `Blob` objects of known sizes and checks what the model
 * makes of them: which file is offered, under which name, what "saved" says,
 * when the original is offered instead, and what the batch totals add up to.
 */
import { createChecker, fixture } from "./lib/selftest-kit.mjs";

const { check, section, report, crashed } = createChecker("ui-outcome-selftest");
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

const model = await import("../src/features/images/model.ts");
const plan = await import("../src/features/images/engine/plan.ts");
const { formatBytes, formatSavingsPercent } = await import("../src/lib/format.ts");

const blobOf = (size, type = "image/webp") => new Blob([new Uint8Array(size)], { type });
const settings = { format: "webp", quality: 78, maxWidth: null, maxHeight: null, strategy: "single" };

let ids = 0;
/** A queue item as the screen holds it. `sizes` are the byte counts of the encoded candidates, null for one that failed. */
function item(file, { status = "done", formats = ["webp"], sizes = [100], strategy = "single", preferOriginal = false, width = 800, height = 600, outputWidth = width, outputHeight = height, source = {} } = {}) {
  const sourceInfo = { format: "jpeg", mime: "image/jpeg", width, height, orientation: null, mayHaveAlpha: false, metadata: { exif: false, gps: false, icc: false, xmp: false }, traits: [], nameMismatch: null, ...source };
  if (status !== "done") return { id: `file-${(ids += 1)}`, file, status, source: status === "rejected" || status === "checking" ? null : sourceInfo, problem: null, stage: null, outcome: null };
  const candidates = formats.map((format, index) => ({ format, quality: 78, note: format, blob: sizes[index] === null ? null : blobOf(sizes[index], plan.OUTPUT_MIME[format]), problem: sizes[index] === null ? "failed" : null, encoder: format === "avif" ? "wasm" : "browser", ms: 5 }));
  const selection = plan.selectOutcome(strategy, file.size, candidates);
  return {
    id: `file-${(ids += 1)}`,
    file,
    status,
    source: sourceInfo,
    problem: null,
    stage: null,
    outcome: { result: { id: "x", decodedWidth: width, decodedHeight: height, outputWidth, outputHeight, resized: outputWidth !== width, usesTransparency: null, flattened: false, candidates, decodeMs: 3 }, skipped: [], selection, preferOriginal, durationMs: 12, settingsKey: model.settingsKey({ ...settings, strategy }) },
  };
}

const photoBytes = fixture("photo-800x600.jpg");
const photo = new File([photoBytes], "photo-800x600.jpg", { type: "image/jpeg" });
const flat = new File([fixture("flat-600x400.png")], "flat-600x400.png", { type: "image/png" });

/* ------------------------------------------------------------- one result */
section("one result: the offered file, its name and its numbers");
{
  const converted = item(photo, { sizes: [90_174] });
  const final = model.finalOf(converted);
  check("the offered file is the encoder's Blob itself", final.blob === converted.outcome.result.candidates[0].blob && final.isOriginal === false);
  check("\"After\" is that Blob's size: 90,174 bytes, shown as 88.1 KB", final.bytes === 90_174 && final.bytes === final.blob.size && formatBytes(final.bytes) === "88.1 KB");
  check("\"Before\" is the selected file's size: 164,543 bytes, shown as 160.7 KB", converted.file.size === photoBytes.length && photoBytes.length === 164_543 && formatBytes(converted.file.size) === "160.7 KB");
  check("\"Saved\" is the difference of the two: 74,369 bytes, +45.2%", final.savedBytes === 164_543 - 90_174 && final.savingsPercent === 45.2 && formatSavingsPercent(final.savingsPercent) === "+45.2%" && final.grew === false);
  check("the name is the source's name with a suffix and the new extension", final.filename === "photo-800x600-optimized.webp" && final.formatLabel === "WebP" && final.format === "webp");
  check("the size is the output's size, and how it was encoded is stated", final.width === 800 && final.height === 600 && final.encoder === "browser");
  const resized = model.finalOf(item(photo, { sizes: [9_000], outputWidth: 200, outputHeight: 150 }));
  check("a resized result reports the output's dimensions, not the source's", resized.width === 200 && resized.height === 150);
  const avif = model.finalOf(item(photo, { formats: ["avif"], sizes: [128_079] }));
  check("an AVIF result names the WebAssembly codec as its encoder", avif.encoder === "wasm" && avif.filename === "photo-800x600-optimized.avif" && avif.formatLabel === "AVIF");
}

section("a result that is larger than its original is shown as larger, and the original is offered");
{
  const larger = item(flat, { formats: ["jpeg"], sizes: [4_994], source: { format: "png" } });
  const final = model.finalOf(larger);
  check("the growth is reported as it is: 670 → 4,994 bytes, −645.4%", final.bytes === 4_994 && final.savedBytes === -4_324 && final.savingsPercent === -645.4 && final.grew === true && formatSavingsPercent(final.savingsPercent) === "-645.4%");
  check("the screen is told to offer the original for this file", model.convertedIsNotSmaller(larger) === true);
  const kept = { ...larger, outcome: { ...larger.outcome, preferOriginal: true } };
  const keptFinal = model.finalOf(kept);
  check("after \"Keep original\", the offered file is the selected File object itself, byte for byte", keptFinal.blob === flat && keptFinal.isOriginal === true && keptFinal.bytes === 670);
  check("it keeps its own name and format, and shows 0 saved instead of a loss", keptFinal.filename === "flat-600x400.png" && keptFinal.formatLabel === "PNG" && keptFinal.format === null && keptFinal.savedBytes === 0 && keptFinal.savingsPercent === 0 && keptFinal.grew === false && keptFinal.encoder === null);
  check("the reason says it was the user's choice", /You chose to keep the original/.test(keptFinal.originalReason));
  check("the converted file is still known, so the choice can be undone", model.chosenCandidate(kept.outcome).blob.size === 4_994 && model.convertedIsNotSmaller(kept) === true);
  const equal = item(photo, { sizes: [photo.size] });
  check("a result of exactly the same size also counts as \"not smaller\"", model.convertedIsNotSmaller(equal) === true && model.finalOf(equal).grew === false && model.finalOf(equal).savedBytes === 0);
  check("a smaller result does not", model.convertedIsNotSmaller(item(photo, { sizes: [photo.size - 1] })) === false);
}

section("strategies");
{
  const best = item(photo, { strategy: "best-effort", formats: ["webp", "avif", "jpeg"], sizes: [90_174, 128_079, 68_866] });
  check("best-effort offers the smallest of the encoded files: the 68,866-byte JPEG", model.finalOf(best).bytes === 68_866 && model.finalOf(best).format === "jpeg" && model.finalOf(best).filename === "photo-800x600-optimized.jpg");
  const partial = item(photo, { strategy: "best-effort", formats: ["webp", "avif", "jpeg"], sizes: [null, 128_079, null] });
  check("a format that failed is left out of the comparison", model.finalOf(partial).format === "avif");
  const grewBest = item(flat, { strategy: "best-effort", formats: ["webp", "avif", "jpeg"], sizes: [1_438, 700, 4_994], source: { format: "png" } });
  check("best-effort can still be larger than the original, and then says so", model.finalOf(grewBest).bytes === 700 && model.finalOf(grewBest).grew === true && model.convertedIsNotSmaller(grewBest) === true);
  const safe = item(flat, { strategy: "no-regression", formats: ["webp", "avif", "jpeg"], sizes: [1_438, 700, 4_994], source: { format: "png" } });
  const safeFinal = model.finalOf(safe);
  check("no-regression offers the original in that case, with the reason", safeFinal.isOriginal === true && safeFinal.blob === flat && safeFinal.bytes === 670 && /at least as large as the original/.test(safeFinal.originalReason), JSON.stringify({ ...safeFinal, blob: undefined }));
  check("and nothing is offered as an alternative: there is no converted file to prefer", model.chosenCandidate(safe.outcome) === null && model.convertedIsNotSmaller(safe) === false);
  const won = item(flat, { strategy: "no-regression", formats: ["webp", "avif"], sizes: [1_438, 624], source: { format: "png" } });
  check("no-regression offers a converted file when one is smaller: 624 bytes instead of 670", model.finalOf(won).bytes === 624 && model.finalOf(won).isOriginal === false && model.finalOf(won).savedBytes === 46);
  const nothing = item(photo, { strategy: "no-regression", formats: ["webp", "avif"], sizes: [null, null] });
  check("when no format could be encoded, no-regression still has a file to offer: the original", model.finalOf(nothing).isOriginal === true && /No format could be encoded/.test(model.finalOf(nothing).originalReason));
}

section("files without a result offer nothing");
{
  const states = ["checking", "ready", "rejected", "queued", "processing", "failed", "cancelled"];
  check("only a finished file has a download", states.every((status) => model.finalOf(item(photo, { status })) === null));
  check("every state has a label and a tone for its chip", [...states, "done"].every((status) => typeof model.STATUS_LABEL[status]?.label === "string" && ["neutral", "accent", "ok", "warn", "danger"].includes(model.STATUS_LABEL[status].tone)));
  check("a refused file reads \"not accepted\", in the danger tone", model.STATUS_LABEL.rejected.label === "not accepted" && model.STATUS_LABEL.rejected.tone === "danger");
}

/* -------------------------------------------------------------- the batch */
section("batch totals: sums of real sizes, over the files that have a result");
{
  const items = [
    item(photo, { sizes: [90_174] }),
    item(flat, { formats: ["jpeg"], sizes: [4_994], source: { format: "png" } }),
    item(new File([new Uint8Array(1_000)], "c.png"), { strategy: "no-regression", formats: ["webp"], sizes: [2_000] }),
    item(new File([new Uint8Array(5_000)], "d.tiff"), { status: "failed" }),
    item(new File([new Uint8Array(7_000)], "e.gif"), { status: "rejected" }),
    item(new File([new Uint8Array(9_000)], "f.jpg"), { status: "cancelled" }),
    item(new File([new Uint8Array(3_000)], "g.jpg"), { status: "ready" }),
  ];
  const summary = model.summarize(items);
  const input = 164_543 + 670 + 1_000;
  const output = 90_174 + 4_994 + 1_000;
  check("three files have a result: two converted, one original kept", summary.done === 3 && summary.converted === 2 && summary.keptOriginal === 1);
  check("the input total counts only those three files", summary.inputBytes === input, `${summary.inputBytes} vs ${input}`);
  check("the output total counts what is actually offered, the kept original at its own size", summary.outputBytes === output, `${summary.outputBytes} vs ${output}`);
  check("saved and its percentage follow from the two totals", summary.savedBytes === input - output && summary.savingsPercent === Math.round(((input - output) / input) * 1000) / 10);
  check("one result is larger than its original, and is counted", summary.grew === 1);
  check("failed, refused and cancelled files are counted separately and add no bytes", summary.failed === 1 && summary.rejected === 1 && summary.cancelled === 1);
  const afterKeeping = model.summarize(items.map((entry, index) => (index === 1 ? { ...entry, outcome: { ...entry.outcome, preferOriginal: true } } : entry)));
  check("keeping the original for the larger file changes the totals accordingly", afterKeeping.outputBytes === 90_174 + 670 + 1_000 && afterKeeping.grew === 0 && afterKeeping.keptOriginal === 2 && afterKeeping.converted === 1);
  const empty = model.summarize([]);
  check("an empty queue adds up to zero, without dividing by it", empty.done === 0 && empty.inputBytes === 0 && empty.savingsPercent === 0 && empty.savedBytes === 0);
  const sum = model.summarize(Array.from({ length: 300 }, (_, index) => item(new File([new Uint8Array(1_000 + index)], `n-${index}.jpg`), { sizes: [500 + index] })));
  check("300 files add up exactly", sum.done === 300 && sum.inputBytes === 300 * 1_000 + (299 * 300) / 2 && sum.outputBytes === 300 * 500 + (299 * 300) / 2 && sum.savedBytes === 150_000);
}

/* ------------------------------------------------------- stale results */
section("a result knows which settings made it");
{
  const key = model.settingsKey;
  check("in single mode, changing the format, quality or a size limit makes a result out of date", new Set([key(settings), key({ ...settings, format: "avif" }), key({ ...settings, quality: 60 }), key({ ...settings, maxWidth: 1_200 }), key({ ...settings, maxHeight: 800 })]).size === 5);
  check("in a comparison, the format control has no effect, so changing it does not", key({ ...settings, strategy: "best-effort", format: "webp" }) === key({ ...settings, strategy: "best-effort", format: "png" }));
  check("changing the strategy does", new Set([key(settings), key({ ...settings, strategy: "best-effort" }), key({ ...settings, strategy: "no-regression" })]).size === 3);
  const done = item(photo, { sizes: [100] });
  check("a finished file is not processed again with the same settings", model.isPending(done, key(settings)) === false);
  check("it is processed again after a setting changed", model.isPending(done, key({ ...settings, quality: 50 })) === true);
  check("ready, failed and cancelled files are processed by the next run", ["ready", "failed", "cancelled"].every((status) => model.isPending(item(photo, { status }), key(settings)) === true));
  check("refused files and files still being checked are not", ["rejected", "checking"].every((status) => model.isPending(item(photo, { status }), key(settings)) === false));
  check("files already in work are not queued twice", ["queued", "processing"].every((status) => model.isPending(item(photo, { status }), key(settings)) === false));
}

const ok = report();
if (ok) console.log("\nAll result-model checks passed.");
process.exit(ok ? 0 : 1);
