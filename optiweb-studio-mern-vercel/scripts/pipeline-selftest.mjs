#!/usr/bin/env node
/**
 * Self-test of the image pipeline and of the engine that schedules it.
 * Needs no browser.
 *
 *   npm run test:pipeline
 *
 * Part 1 runs the real pipeline (`runJob`) on a canvas that records what is
 * drawn instead of drawing it. That shows the steps and their order: what is
 * decoded, at which size it is drawn, how a rotation is applied, when
 * transparency is looked for, what each encoder is asked for, and that memory
 * is given back on every path, including failures and cancellation.
 *
 * Part 2 runs the real engine with workers that the test controls. That shows
 * the scheduling: how many files are in work at once, the pixel budget, the
 * order, cancellation, time limits, crashes, and the fallback to the page.
 *
 * What this cannot show is that a browser's decoder and encoders produce
 * correct files. `npm run test:browser` does that, in a real browser.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { createChecker } from "./lib/selftest-kit.mjs";

const { check, section, report, crashed } = createChecker("pipeline-selftest");
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

const MP = 1_000_000;
const plan = await import("../src/features/images/engine/plan.ts");
const { createImageEngine } = await import("../src/features/images/engine/engine.ts");
/** A fresh copy of the pipeline module: what it learns about a browser (which types it encodes, whether it rotates) is remembered per copy. */
let copies = 0;
const loadPipeline = () => import(`../src/features/images/engine/pipeline.ts?copy=${(copies += 1)}`);

/* ----------------------------------------------------- a recording canvas */

/**
 * A stand-in for the browser's decoder and canvas. Nothing is drawn: every
 * call is recorded, and pixel reads answer from a few switches.
 */
function recordingBackend(options = {}) {
  const {
    width = 800,
    height = 600,
    decoderAppliesOrientation = true,
    transparent = false,
    usable = true,
    context2d = true,
    decodeError = null,
    encodedBytes = { "image/webp": 300, "image/jpeg": 500, "image/png": 900 },
    refuses = [],
    afterDecode = null,
  } = options;
  const log = { canvases: [], decodes: 0, released: 0, encodes: [], pixelReads: 0 };
  const decodedImage = { name: "decoded" };

  const createCanvas = (canvasWidth, canvasHeight) => {
    const canvas = { width: canvasWidth, height: canvasHeight, created: `${canvasWidth}x${canvasHeight}`, calls: [] };
    const ctx = {
      fillStyle: "",
      globalCompositeOperation: "source-over",
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      probed: false,
      flattened: false,
      fillRect(x, y, w, h) {
        canvas.calls.push(["fillRect", x, y, w, h, this.fillStyle, this.globalCompositeOperation]);
        if (w === 1 && h === 1) this.probed = true;
        if (this.globalCompositeOperation === "destination-over") this.flattened = true;
      },
      clearRect(x, y, w, h) {
        canvas.calls.push(["clearRect", x, y, w, h]);
        this.probed = false;
      },
      setTransform(...matrix) {
        canvas.calls.push(["setTransform", ...matrix]);
      },
      drawImage(source, ...rect) {
        canvas.calls.push(["drawImage", source === decodedImage ? "decoded" : source.created, ...rect, this.imageSmoothingQuality]);
      },
      getImageData(x, y, w, h) {
        const data = new Uint8ClampedArray(w * h * 4);
        // The usability probe: one pixel that was just written.
        if (w === 1 && h === 1 && this.probed) {
          data[3] = usable ? 255 : 0;
          return { data, width: w, height: h };
        }
        log.pixelReads += 1;
        canvas.calls.push(["getImageData", x, y, w, h]);
        data.fill(255);
        if (transparent && !this.flattened && y === 0) data[3] = 0;
        return { data, width: w, height: h };
      },
    };
    canvas.getContext = () => (context2d ? ctx : null);
    canvas.ctx = ctx;
    // The page's canvas has toBlob(callback); the worker's has convertToBlob. The backend under test hides the difference.
    log.canvases.push(canvas);
    return canvas;
  };

  const backend = {
    createCanvas,
    async toBlob(canvas, type, quality) {
      if (canvas.created !== "1x1") log.encodes.push({ canvas: `${canvas.width}x${canvas.height}`, type, quality, flattened: canvas.ctx.flattened });
      if (canvas.created !== "1x1" && refuses.includes(type)) return null;
      return new Blob([new Uint8Array(encodedBytes[type] ?? 100)], { type });
    },
    async decode(blob) {
      if (blob !== backend.file) {
        // The pipeline's own 2 × 1 test photo, which asks whether this decoder applies EXIF rotation.
        return decoderAppliesOrientation ? { image: {}, width: 1, height: 2, release() {} } : { image: {}, width: 2, height: 1, release() {} };
      }
      log.decodes += 1;
      if (decodeError) throw decodeError;
      if (afterDecode) afterDecode();
      return { image: decodedImage, width, height, release: () => { log.released += 1; } };
    },
    file: null,
  };
  return { backend, log };
}

const candidate = (format, quality = 78, requiresOpaque = false) => ({ format, quality, note: `${format} at quality ${quality}`, requiresOpaque });

async function run(options = {}, jobOptions = {}) {
  const { runJob } = await loadPipeline();
  const { backend, log } = recordingBackend(options);
  const file = new Blob([new Uint8Array(1_000)], { type: "image/jpeg" });
  backend.file = file;
  const stages = [];
  let cancelled = false;
  const job = {
    id: "job-1",
    file,
    source: { format: "jpeg", width: options.width ?? 800, height: options.height ?? 600, orientation: null, mayHaveAlpha: false, ...jobOptions.source },
    maxWidth: jobOptions.maxWidth ?? null,
    maxHeight: jobOptions.maxHeight ?? null,
    candidates: jobOptions.candidates ?? [candidate("webp")],
    avifMaxPixels: jobOptions.avifMaxPixels ?? 24 * MP,
  };
  const hooks = { stage: (stage, detail) => stages.push(detail ? `${stage}:${detail}` : stage), cancelled: () => cancelled };
  let result = null;
  let error = null;
  try {
    if (jobOptions.cancelAfterDecode) {
      const original = backend.decode;
      backend.decode = async (blob) => { const decoded = await original(blob); if (blob === file) cancelled = true; return decoded; };
    }
    result = await runJob(job, backend, hooks);
  } catch (caught) {
    error = caught;
  }
  const output = log.canvases.filter((canvas) => canvas.created !== "1x1").at(-1) ?? null;
  return { result, error, log, stages, output, drawn: log.canvases.filter((canvas) => canvas.created !== "1x1") };
}

/* ============================================================== PART 1 === */
section("pipeline: decode once, draw at the planned size, encode what was asked");
{
  const { result, log, stages, output } = await run({ width: 800, height: 600 }, { candidates: [candidate("webp", 78)] });
  check("the file is decoded exactly once", log.decodes === 1);
  check("the output canvas has the source's size when no limit is set", output.created === "800x600" && result.outputWidth === 800 && result.outputHeight === 600 && result.resized === false && result.decodedWidth === 800);
  check("the encoder is asked for image/webp at quality 0.78", log.encodes.length === 1 && log.encodes[0].type === "image/webp" && log.encodes[0].quality === 0.78 && log.encodes[0].canvas === "800x600", JSON.stringify(log.encodes));
  check("the result carries the encoder's file as it is: its size is the file's size", result.candidates.length === 1 && result.candidates[0].blob.size === 300 && result.candidates[0].blob.type === "image/webp" && result.candidates[0].encoder === "browser" && result.candidates[0].problem === null);
  check("the steps are reported in order", stages.join(" > ") === "decoding > encoding > encoding:WebP", stages.join(" > "));
  check("for a format without transparency, no pixel is read back to look for it", log.pixelReads === 0 && result.usesTransparency === null);
  const png = await run({}, { candidates: [candidate("png", 78)] });
  check("PNG is lossless: the encoder is given no quality", png.log.encodes[0].type === "image/png" && png.log.encodes[0].quality === undefined);
  const jpeg = await run({}, { candidates: [candidate("jpeg", 91)] });
  check("JPEG at quality 91 is asked for as 0.91", jpeg.log.encodes[0].type === "image/jpeg" && jpeg.log.encodes[0].quality === 0.91);
}

section("pipeline: resizing");
{
  const { result, drawn, output, stages } = await run({ width: 800, height: 600 }, { maxWidth: 400 });
  check("800 × 600 with max width 400 is drawn at 400 × 300, in one step", result.outputWidth === 400 && result.outputHeight === 300 && result.resized === true && drawn.length === 2 && output.created === "400x300", drawn.map((canvas) => canvas.created).join(" "));
  check("the step is reported as resizing", stages[1] === "resizing");
  const big = await run({ width: 4_000, height: 3_000 }, { maxWidth: 500 });
  const steps = big.drawn.map((canvas) => canvas.created).join(" > ");
  check("a large reduction is done in halving steps: 4000 × 3000 goes through 2000, 1000 and 500 px", steps === "2000x1500 > 1000x750 > 500x375 > 500x375", steps);
  check("every draw asks for high-quality smoothing", big.drawn.every((canvas) => canvas.calls.filter((call) => call[0] === "drawImage").every((call) => call.at(-1) === "high")));
  const first = big.drawn[0].calls.find((call) => call[0] === "drawImage");
  check("the first step reads the whole decoded image", first[1] === "decoded" && first.slice(2, 6).join() === "0,0,4000,3000");
  check("the intermediate canvases are emptied as soon as they are no longer needed", big.drawn.slice(0, -1).every((canvas) => canvas.width === 0 && canvas.height === 0), big.drawn.map((canvas) => `${canvas.width}x${canvas.height}`).join(" "));
  const small = await run({ width: 160, height: 100 }, { maxWidth: 1_920, maxHeight: 1_080 });
  check("an image smaller than the limits is not enlarged", small.result.outputWidth === 160 && small.result.outputHeight === 100 && small.result.resized === false);
  const both = await run({ width: 800, height: 600 }, { maxWidth: 600, maxHeight: 300 });
  check("with two limits the tighter one decides", both.result.outputWidth === 400 && both.result.outputHeight === 300);
}

section("pipeline: rotation");
{
  // The EXIF definition, written down independently of the code: where the stored top-left and top-right pixels are shown.
  const SHOWN_AT = { 1: ["TL", "TR"], 2: ["TR", "TL"], 3: ["BR", "BL"], 4: ["BL", "BR"], 5: ["TL", "BL"], 6: ["TR", "BR"], 7: ["BR", "TR"], 8: ["BL", "TL"] };
  const { orientationMatrix } = await loadPipeline();
  const wrong = [];
  for (const [orientation, [topLeft, topRight]] of Object.entries(SHOWN_AT)) {
    const storedWidth = 240;
    const storedHeight = 160;
    const turned = Number(orientation) >= 5;
    const shownWidth = turned ? storedHeight : storedWidth;
    const shownHeight = turned ? storedWidth : storedHeight;
    const [a, b, c, d, e, f] = orientationMatrix(Number(orientation), storedWidth, storedHeight);
    const corner = (x, y) => {
      const shownX = a * x + c * y + e;
      const shownY = b * x + d * y + f;
      const inside = shownX > 0 && shownX < shownWidth && shownY > 0 && shownY < shownHeight;
      return inside ? `${shownY < shownHeight / 2 ? "T" : "B"}${shownX < shownWidth / 2 ? "L" : "R"}` : "outside";
    };
    const got = [corner(0.5, 0.5), corner(storedWidth - 0.5, 0.5)];
    if (got[0] !== topLeft || got[1] !== topRight) wrong.push(`${orientation}: ${got.join("/")} instead of ${topLeft}/${topRight}`);
    // Every stored pixel must land inside the shown image.
    if ([[0.5, 0.5], [storedWidth - 0.5, 0.5], [0.5, storedHeight - 0.5], [storedWidth - 0.5, storedHeight - 0.5]].some(([x, y]) => corner(x, y) === "outside")) wrong.push(`${orientation}: a corner falls outside`);
  }
  check("all eight EXIF orientations put the stored corners where the standard says", wrong.length === 0, wrong.join("; "));

  const source = { orientation: 6, format: "jpeg", width: 160, height: 240 };
  const manual = await run({ width: 240, height: 160, decoderAppliesOrientation: false }, { source });
  const transform = manual.output.calls.find((call) => call[0] === "setTransform");
  check("when the decoder does not rotate, the pipeline does: a 240 × 160 photo with orientation 6 becomes 160 × 240", manual.result.outputWidth === 160 && manual.result.outputHeight === 240 && manual.output.created === "160x240" && transform?.slice(1).join() === "0,1,-1,0,160,0", JSON.stringify(transform));
  check("the transform is reset after the draw", manual.output.calls.filter((call) => call[0] === "setTransform").at(-1).slice(1).join() === "1,0,0,1,0,0");
  const native = await run({ width: 160, height: 240, decoderAppliesOrientation: true }, { source });
  check("when the decoder already rotated, the pipeline does not rotate a second time", native.result.outputWidth === 160 && native.result.outputHeight === 240 && !native.output.calls.some((call) => call[0] === "setTransform" && call.slice(1).join() !== "1,0,0,1,0,0"), JSON.stringify(native.output.calls.filter((call) => call[0] === "setTransform")));
  const limited = await run({ width: 240, height: 160, decoderAppliesOrientation: false }, { source, maxWidth: 80 });
  check("a width limit applies to the image as shown: 160 × 240 with max width 80 is 80 × 120", limited.result.outputWidth === 80 && limited.result.outputHeight === 120, `${limited.result.outputWidth}x${limited.result.outputHeight}`);
}

section("pipeline: transparency");
{
  const source = { format: "png", mayHaveAlpha: true };
  const compare = [candidate("jpeg", 78, true), candidate("webp", 78)];
  const alpha = await run({ transparent: true }, { source, candidates: compare });
  check("a non-opaque pixel is found, and the result says the image uses transparency", alpha.result.usesTransparency === true && alpha.log.pixelReads >= 1);
  check("in a comparison, JPEG is not tried for it, and the reason is stated", alpha.result.candidates[0].blob === null && /transparency, which JPEG cannot store/.test(alpha.result.candidates[0].problem) && alpha.log.encodes.map((encode) => encode.type).join() === "image/webp", JSON.stringify(alpha.result.candidates[0]));
  check("so nothing was filled with white", alpha.result.flattened === false && alpha.log.encodes.every((encode) => encode.flattened === false));
  const opaque = await run({ transparent: false }, { source, candidates: compare });
  check("an opaque PNG is compared as JPEG too", opaque.result.usesTransparency === false && opaque.result.candidates.every((entry) => entry.blob !== null));
  check("JPEG is encoded last, whatever its place in the list", opaque.log.encodes.map((encode) => encode.type).join() === "image/webp,image/jpeg");
  const forced = await run({ transparent: true }, { source, candidates: [candidate("jpeg", 78, false)] });
  const fill = forced.output.calls.find((call) => call[0] === "fillRect" && call[6] === "destination-over");
  check("when JPEG is the chosen format, transparent areas are filled with white underneath the image", forced.result.flattened === true && fill?.slice(1, 6).join() === "0,0,800,600,#fff" && forced.log.encodes[0].flattened === true, JSON.stringify(fill));
  const mixed = await run({ transparent: true }, { source, candidates: [candidate("jpeg", 78, false), candidate("webp", 78), candidate("png", 78)] });
  check("the white fill never reaches the other formats: they are encoded before it", mixed.log.encodes.map((encode) => `${encode.type.slice(6)}:${encode.flattened}`).join() === "webp:false,png:false,jpeg:true", JSON.stringify(mixed.log.encodes));
}

section("pipeline: limits and failures are reported, not swallowed");
{
  const avif = await run({ width: 2_000, height: 1_500 }, { candidates: [candidate("webp"), candidate("avif")], avifMaxPixels: 2 * MP });
  check("AVIF above the device's limit is not tried; the other format is still produced", avif.result.candidates[1].blob === null && /not tried: the output is above 2 MP/.test(avif.result.candidates[1].problem) && avif.result.candidates[0].blob?.size === 300, JSON.stringify(avif.result.candidates[1]));
  const control = await run({}, { candidates: [candidate("jpeg"), candidate("webp")] });
  check("(control) both encoders answer", control.result.candidates.every((entry) => entry.blob !== null));
  const partial = await run({ refuses: ["image/jpeg"] }, { candidates: [candidate("jpeg"), candidate("webp")] });
  check("an encoder that returns no file fails that one format, with a reason; the other format is kept", partial.result.candidates[0].blob === null && /JPEG encoder returned no file/.test(partial.result.candidates[0].problem) && partial.result.candidates[1].blob !== null, JSON.stringify(partial.result.candidates[0]));
  const undecodable = await run({ decodeError: new Error("The source image could not be decoded.") }, { source: { format: "tiff" } });
  check("a file the browser cannot decode fails with decode_failed and a hint for its format", undecodable.error?.code === "decode_failed" && /TIFF/.test(undecodable.error.message) && /Safari/.test(undecodable.error.hint) && undecodable.result === null, `${undecodable.error?.code}: ${undecodable.error?.message}`);
  const tooLarge = await run({ width: 12_000, height: 9_000, usable: false });
  check("a canvas the browser cannot hold is detected and named, with a next step", tooLarge.error?.code === "canvas_too_large" && /12,000 × 9,000/.test(tooLarge.error.message) && /maximum width/.test(tooLarge.error.hint), `${tooLarge.error?.code}: ${tooLarge.error?.message}`);
  const noContext = await run({ context2d: false });
  check("no drawing surface at all is reported as canvas_unavailable", noContext.error?.code === "canvas_unavailable");
  const stopped = await run({}, { cancelAfterDecode: true, candidates: [candidate("webp"), candidate("jpeg")] });
  check("a cancel that arrives during decoding stops the job before anything is drawn or encoded", stopped.error?.code === "cancelled" && stopped.log.encodes.length === 0 && stopped.drawn.length === 0, `${stopped.error?.code}, ${stopped.log.encodes.length} encodes`);
}

section("pipeline: memory is given back on every path");
{
  const cases = {
    "a finished job": await run({}, { candidates: [candidate("webp"), candidate("jpeg")] }),
    "a resized job": await run({ width: 4_000, height: 3_000 }, { maxWidth: 500 }),
    "an encoder failure": await run({ refuses: ["image/webp"] }),
    "a canvas that is too large": await run({ usable: false }),
    "a cancelled job": await run({}, { cancelAfterDecode: true }),
  };
  for (const [label, outcome] of Object.entries(cases)) {
    const canvases = outcome.drawn;
    check(`${label}: the decoded image is released, and every canvas is emptied`, outcome.log.released >= 1 && canvases.every((canvas) => canvas.width === 0 && canvas.height === 0), `released ${outcome.log.released}, canvases ${canvases.map((canvas) => `${canvas.width}x${canvas.height}`).join(" ")}`);
  }
  const done = cases["a finished job"];
  check("the decoded image is released before encoding starts, not after: it is the largest thing in memory", done.log.released >= 1 && done.result.candidates.every((entry) => entry.blob !== null));
}

/* ============================================================== PART 2 === */

/** A worker the test controls. It does nothing by itself: the test decides when a job finishes, fails, stalls or crashes. */
function fakeWorkers({ announce = true, failToStart = false } = {}) {
  const created = [];
  const posted = [];
  const createWorker = () => {
    if (failToStart) throw new Error("Failed to construct 'Worker'");
    const listeners = { message: [], error: [], messageerror: [] };
    const worker = {
      index: created.length,
      terminated: false,
      job: null,
      jobs: [],
      addEventListener(type, listener) { listeners[type].push(listener); },
      postMessage(message) {
        if (worker.terminated) throw new Error("postMessage on a terminated worker");
        worker.job = message.job;
        worker.jobs.push(message.job.id);
        posted.push({ worker: worker.index, id: message.job.id });
      },
      terminate() { worker.terminated = true; },
      /** Delivers a message as the browser would. A terminated worker delivers nothing. */
      send(data, { evenIfTerminated = false } = {}) {
        if (worker.terminated && !evenIfTerminated) return;
        for (const listener of listeners.message) listener({ data });
      },
      stage(stage, detail) { worker.send({ type: "stage", id: worker.job.id, stage, detail }); },
      finish(sizes = [100]) {
        const job = worker.job;
        worker.send({ type: "done", result: resultFor(job.id, sizes) });
      },
      fail(code, message = "failed") {
        worker.send({ type: "failed", failure: { id: worker.job.id, code, message, hint: "hint" } });
      },
      crash() { for (const listener of listeners.error) listener({ type: "error" }); },
    };
    created.push(worker);
    if (announce) queueMicrotask(() => worker.send({ type: "ready" }));
    return worker;
  };
  return { createWorker, created, posted };
}

const resultFor = (id, sizes) => ({
  id,
  decodedWidth: 10,
  decodedHeight: 10,
  outputWidth: 10,
  outputHeight: 10,
  resized: false,
  usesTransparency: null,
  flattened: false,
  candidates: sizes.map((size) => ({ format: "webp", quality: 78, note: "WebP", blob: new Blob([new Uint8Array(size)]), problem: null, encoder: "browser", ms: 1 })),
  decodeMs: 1,
});

const engineJob = (id, megapixels = 1, timeoutMs = 60_000) => ({
  request: { id, file: new Blob(["x"]), source: { format: "jpeg", width: 10, height: 10, orientation: null, mayHaveAlpha: false }, maxWidth: null, maxHeight: null, candidates: [candidate("webp")], avifMaxPixels: 24 * MP },
  pixels: megapixels * MP,
  timeoutMs,
});

function recorder() {
  const events = [];
  return {
    events,
    handlers: {
      stage: (id, stage, detail) => events.push(`${id}:stage:${stage}${detail ? `:${detail}` : ""}`),
      done: (id, result) => events.push(`${id}:done:${result.candidates[0].blob.size}`),
      failed: (id, failure) => events.push(`${id}:failed:${failure.code}`),
    },
    of: (id) => events.filter((event) => event.startsWith(`${id}:`)).map((event) => event.slice(id.length + 1)),
    ended: () => events.filter((event) => /:(done|failed):/.test(event)),
  };
}
const tick = () => sleep(5);
const limitsFor = (concurrency, budgetMegapixels = 100) => ({ ...plan.resolveEngineLimits({ deviceMemory: 8, cores: 16 }), concurrency, pixelBudget: budgetMegapixels * MP });

section("engine: never more files in work than the device's limit");
{
  const workers = fakeWorkers();
  const engine = createImageEngine({ limits: limitsFor(2), createWorker: workers.createWorker });
  const seen = recorder();
  engine.submit(["a", "b", "c", "d", "e", "f"].map((id) => engineJob(id)), seen.handlers);
  await tick();
  check("six files, two workers: two are started, four wait", workers.created.length === 2 && workers.posted.map((entry) => entry.id).join() === "a,b" && engine.busy() === true, workers.posted.map((entry) => entry.id).join());
  workers.created[0].stage("decoding");
  workers.created[1].stage("encoding", "WebP");
  check("each worker's progress is reported for the file it is working on", seen.of("a").join() === "stage:decoding" && seen.of("b").join() === "stage:encoding:WebP");
  let peak = 2;
  const inWork = () => workers.created.filter((worker) => !worker.terminated && worker.job && !seen.ended().some((event) => event.startsWith(`${worker.job.id}:`))).length;
  workers.created[0].finish([111]);
  await tick();
  peak = Math.max(peak, inWork());
  check("when one finishes, the next waiting file starts on the worker that became free", workers.posted.map((entry) => `${entry.id}@${entry.worker}`).join() === "a@0,b@1,c@0" && workers.created.length === 2, workers.posted.map((entry) => `${entry.id}@${entry.worker}`).join());
  check("the result is delivered with the file the worker made", seen.of("a").at(-1) === "done:111");
  for (let round = 0; round < 6 && engine.busy(); round += 1) {
    for (const worker of workers.created) {
      if (worker.job && !seen.ended().some((event) => event.startsWith(`${worker.job.id}:`))) worker.finish([100]);
    }
    await tick();
    peak = Math.max(peak, inWork());
  }
  check("all six finish, in the order they were submitted", seen.ended().map((event) => event.split(":")[0]).sort().join() === "a,b,c,d,e,f" && workers.posted.map((entry) => entry.id).join() === "a,b,c,d,e,f" && engine.busy() === false, seen.ended().join(" "));
  check("only two workers were ever created, and never more than two files were in work", workers.created.length === 2 && peak === 2, `${workers.created.length} workers, peak ${peak}`);
  engine.submit([engineJob("g")], seen.handlers);
  await tick();
  check("a later file reuses an idle worker instead of starting a new one", workers.created.length === 2 && workers.posted.at(-1).id === "g");
  engine.dispose();
  check("disposing the engine terminates its workers", workers.created.every((worker) => worker.terminated));
}

section("engine: the decoded pixels of all files in work stay inside a budget");
{
  const workers = fakeWorkers();
  const engine = createImageEngine({ limits: limitsFor(4, 50), createWorker: workers.createWorker });
  const seen = recorder();
  engine.submit([engineJob("big-1", 30), engineJob("big-2", 30), engineJob("small", 1)], seen.handlers);
  await tick();
  check("two 30 MP files do not run together under a 50 MP budget, although four workers are allowed", workers.posted.map((entry) => entry.id).join() === "big-1", workers.posted.map((entry) => entry.id).join());
  check("the small file behind them waits its turn: no file is overtaken", !workers.posted.some((entry) => entry.id === "small"));
  workers.created[0].finish();
  await tick();
  check("once the first is done, the second and the small one fit together and both start", workers.posted.map((entry) => entry.id).join() === "big-1,big-2,small", workers.posted.map((entry) => entry.id).join());
  engine.dispose();

  const alone = fakeWorkers();
  const second = createImageEngine({ limits: limitsFor(4, 50), createWorker: alone.createWorker });
  second.submit([engineJob("huge", 80), engineJob("next", 1)], recorder().handlers);
  await tick();
  check("a file larger than the whole budget still runs, alone", alone.posted.map((entry) => entry.id).join() === "huge");
  second.dispose();
}

section("engine: cancelling stops everything, at once");
{
  const workers = fakeWorkers();
  const engine = createImageEngine({ limits: limitsFor(2), createWorker: workers.createWorker });
  const seen = recorder();
  engine.submit(["a", "b", "c", "d", "e"].map((id) => engineJob(id)), seen.handlers);
  await tick();
  workers.created[0].finish([50]);
  await tick();
  const started = Date.now();
  engine.cancelAll();
  const took = Date.now() - started;
  check("the file that had finished keeps its result", seen.of("a").at(-1) === "done:50");
  check("every other file, running or waiting, is reported as cancelled", ["b", "c", "d", "e"].every((id) => seen.of(id).at(-1) === "failed:cancelled"), seen.events.join(" "));
  check("the workers that were running are terminated: that is what stops a decode or an encode already under way", workers.created.filter((worker) => worker.terminated).length === 2, workers.created.map((worker) => worker.terminated).join());
  check(`cancelling returns immediately (${took} ms) and leaves nothing in work`, took < 50 && engine.busy() === false);
  const before = seen.events.length;
  workers.created[1].send({ type: "done", result: resultFor("b", [999]) }, { evenIfTerminated: true });
  await tick();
  check("a result that arrives after the cancel is ignored", seen.events.length === before);
  check("nothing more is sent to a worker after the cancel", workers.posted.length === 3, workers.posted.map((entry) => entry.id).join());
  engine.submit([engineJob("again")], seen.handlers);
  await tick();
  const fresh = workers.created.at(-1);
  check("after a cancel the engine works again, on a new worker", workers.posted.at(-1).id === "again" && fresh.terminated === false);
  fresh.finish([70]);
  await tick();
  check("and delivers the result", seen.of("again").at(-1) === "done:70");
  engine.cancelAll();
  check("cancelling with nothing in work does nothing", seen.events.at(-1) === "again:done:70");
  engine.dispose();
}

section("engine: one file that fails, stalls or crashes does not take the others with it");
{
  const workers = fakeWorkers();
  const engine = createImageEngine({ limits: limitsFor(2), createWorker: workers.createWorker });
  const seen = recorder();
  engine.submit([engineJob("stalls", 1, 40), engineJob("fine"), engineJob("waits")], seen.handlers);
  await tick();
  await sleep(80);
  check("a file that runs past its time limit is stopped and reported as timed out", seen.of("stalls").at(-1) === "failed:timeout" && workers.created[0].terminated === true, seen.events.join(" "));
  check("the file next to it is not affected", !workers.created[1].terminated && seen.of("fine").length === 0);
  check("the waiting file starts, on a new worker", workers.posted.map((entry) => entry.id).join() === "stalls,fine,waits" && workers.created.length === 3);
  workers.created[1].finish([10]);
  workers.created[2].finish([20]);
  await tick();
  check("both other files finish", seen.of("fine").at(-1) === "done:10" && seen.of("waits").at(-1) === "done:20" && engine.busy() === false);

  engine.submit([engineJob("undecodable"), engineJob("ok")], seen.handlers);
  await tick();
  const [first, second] = workers.posted.slice(-2).map((entry) => workers.created[entry.worker]);
  first.fail("decode_failed", "This browser could not decode the TIFF file.");
  second.finish([30]);
  await tick();
  check("a file that cannot be decoded fails by itself; its worker stays in use", seen.of("undecodable").at(-1) === "failed:decode_failed" && seen.of("ok").at(-1) === "done:30" && first.terminated === false);

  engine.submit([engineJob("crashes"), engineJob("survives"), engineJob("after")], seen.handlers);
  await tick();
  const running = workers.posted.slice(-2).map((entry) => workers.created[entry.worker]);
  const count = workers.created.length;
  running[0].crash();
  await tick();
  check("a worker that the browser kills (out of memory) is reported as worker_crashed, and retired", seen.of("crashes").at(-1) === "failed:worker_crashed" && running[0].terminated === true, seen.events.slice(-3).join(" "));
  check("the queue continues on a fresh worker", workers.created.length === count + 1 && workers.posted.at(-1).id === "after");
  running[1].finish([40]);
  workers.created.at(-1).finish([50]);
  await tick();
  check("the files around the crash finish normally", seen.of("survives").at(-1) === "done:40" && seen.of("after").at(-1) === "done:50");
  check("every file got exactly one final answer", ["stalls", "fine", "waits", "undecodable", "ok", "crashes", "survives", "after"].every((id) => seen.of(id).filter((event) => /^(done|failed):/.test(event)).length === 1));
  engine.dispose();
}

section("engine: disposing");
{
  const workers = fakeWorkers();
  const engine = createImageEngine({ limits: limitsFor(2), createWorker: workers.createWorker });
  const seen = recorder();
  engine.submit(["a", "b", "c"].map((id) => engineJob(id)), seen.handlers);
  await tick();
  engine.dispose();
  check("running workers are terminated and nothing is left waiting", workers.created.every((worker) => worker.terminated) && engine.busy() === false);
  check("no event is delivered for a page that is gone", seen.ended().length === 0);
  engine.submit([engineJob("late")], seen.handlers);
  await tick();
  check("a disposed engine starts nothing", workers.posted.length === 2 && workers.created.length === 2);
}

section("engine: where a worker cannot be used, the same pipeline runs on the page");
{
  // What the page backend needs from a browser, supplied here: a decoder and a canvas.
  let decoding = 0;
  let peak = 0;
  let decodes = 0;
  globalThis.createImageBitmap = async () => {
    decoding += 1;
    decodes += 1;
    peak = Math.max(peak, decoding);
    await sleep(15);
    decoding -= 1;
    return { width: 8, height: 6, close() {} };
  };
  globalThis.document = {
    createElement: () => {
      const { backend } = recordingBackend();
      const canvas = backend.createCanvas(0, 0);
      canvas.toBlob = (callback, type) => callback(new Blob([new Uint8Array(77)], { type }));
      return canvas;
    },
  };

  for (const [label, options] of [["a worker that fails before it ever answers", { announce: false }], ["a worker that cannot be constructed", { failToStart: true }]]) {
    const workers = fakeWorkers(options);
    const engine = createImageEngine({ limits: limitsFor(4), createWorker: workers.createWorker });
    const seen = recorder();
    peak = 0;
    engine.submit(["a", "b", "c"].map((id) => engineJob(id)), seen.handlers);
    await tick();
    // Where workers do not work, every one of them fails, each with its own error event. Last first, to show that the order of the files survives.
    for (const worker of [...workers.created].reverse()) worker.crash();
    for (let waited = 0; waited < 100 && engine.busy(); waited += 1) await sleep(20);
    check(`${label}: all three files are still processed, in the order they were submitted`, seen.ended().join() === "a:done:77,b:done:77,c:done:77", seen.ended().join(" "));
    check(`${label}: on the page, one file at a time, whatever the worker limit was`, peak === 1, `peak ${peak}`);
    const workersBefore = workers.created.length;
    engine.submit([engineJob("later")], seen.handlers);
    for (let waited = 0; waited < 100 && engine.busy(); waited += 1) await sleep(20);
    check(`${label}: later files do not try a worker again`, workers.created.length === workersBefore && seen.of("later").at(-1) === "done:77");
    engine.dispose();
  }

  const reported = fakeWorkers();
  const engine = createImageEngine({ limits: limitsFor(2), createWorker: reported.createWorker });
  const seen = recorder();
  engine.submit([engineJob("a")], seen.handlers);
  await tick();
  reported.created[0].fail("canvas_unavailable");
  for (let waited = 0; waited < 100 && engine.busy(); waited += 1) await sleep(20);
  check("a worker that reports it has no canvas hands the file to the page instead of failing it", seen.of("a").at(-1) === "done:77" && reported.created[0].terminated === true, seen.events.join(" "));

  const before = decodes;
  const pageOnly = createImageEngine({ limits: limitsFor(4), mode: "page" });
  const pageSeen = recorder();
  pageOnly.submit(["p1", "p2", "p3"].map((id) => engineJob(id)), pageSeen.handlers);
  await sleep(5);
  pageOnly.cancelAll();
  await sleep(120);
  check("cancelling on the page reports every file as cancelled, and a result that arrives later is dropped", ["p1", "p2", "p3"].every((id) => pageSeen.of(id).filter((event) => /^(done|failed):/.test(event)).join() === "failed:cancelled"), pageSeen.events.join(" "));
  check("the files that were still waiting were never decoded", decodes - before <= 1, `${decodes - before} decodes`);
  pageOnly.dispose();
  delete globalThis.createImageBitmap;
  delete globalThis.document;
}

const ok = report();
if (ok) console.log("\nAll pipeline and engine checks passed.");
process.exit(ok ? 0 : 1);
