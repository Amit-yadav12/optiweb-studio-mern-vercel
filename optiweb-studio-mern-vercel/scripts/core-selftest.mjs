#!/usr/bin/env node
/**
 * Self-test of the logic that needs no browser: everything the app decides
 * before, and after, a pixel is touched.
 *
 *   npm run test:unit
 *
 *  - The header parser: formats are recognised from their bytes, sizes are
 *    read without decoding, and damaged or hostile input never throws.
 *  - The pre-decode check: what is refused, and why.
 *  - The planner: safety limits per device, output sizes, the candidates each
 *    strategy tries, which candidate wins, names, time limits, scheduling.
 *  - The stylesheet and asset analysis that run in the page.
 *  - Settings validation.
 *
 * Expected sizes come from the fixtures' names and from the files' own bytes,
 * never from the code under test.
 */
import { animatedPng, createChecker, fixture, pngDeclaring, solidBmp, solidPng } from "./lib/selftest-kit.mjs";

const { check, section, report, crashed } = createChecker("core-selftest");
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

const { readImageHeader, sniffFormat, displayedSize, pixelCount, mimeOfFormat } = await import("../src/shared/imageHeader.ts");
const { inspectFile, formatFromName, HEAD_BYTES } = await import("../src/features/images/engine/inspect.ts");
const plan = await import("../src/features/images/engine/plan.ts");
const { analyzeCss, patchFontDisplay, countFontDisplayGaps, CssInputError, MAX_CSS_CHARS, utf8Bytes } = await import("../src/shared/css.ts");
const { analyzeAssets } = await import("../src/shared/assets.ts");
const { normalizePreferences, DEFAULT_PREFERENCES } = await import("../src/lib/preferences.ts");
const { formatBytes, formatSavingsPercent } = await import("../src/lib/format.ts");
const storageKeys = await import("../src/lib/storage-keys.ts");

const bytes = (buffer) => new Uint8Array(buffer);
const header = (buffer) => readImageHeader(bytes(buffer));
const MP = 1_000_000;

/* ------------------------------------------------------------ signatures */
section("signatures: a file is identified by its first bytes, not by its name");
const FIXTURES = [
  ["photo-800x600.jpg", "jpeg", 800, 600],
  ["progressive-320x240.jpg", "jpeg", 320, 240],
  ["rotated-gps-240x160.jpg", "jpeg", 240, 160],
  ["alpha-320x200.png", "png", 320, 200],
  ["flat-600x400.png", "png", 600, 400],
  ["lossy-400x300.webp", "webp", 400, 300],
  ["lossless-alpha-320x200.webp", "webp", 320, 200],
  ["animated-3f-60x40.webp", "webp", 60, 40],
  ["small-400x300.avif", "avif", 400, 300],
  ["alpha-160x100.avif", "avif", 160, 100],
  ["still-200x150.gif", "gif", 200, 150],
  ["animated-3f-60x40.gif", "gif", 60, 40],
  ["image-200x150.tiff", "tiff", 200, 150],
  ["two-page-60x40.tiff", "tiff", 60, 40],
];
{
  const wrong = FIXTURES.filter(([name, format]) => sniffFormat(bytes(fixture(name))) !== format).map(([name]) => name);
  check(`all ${FIXTURES.length} fixture files are recognised as the format they are`, wrong.length === 0, wrong.join(", "));
  const sizes = FIXTURES.filter(([name, , width, height]) => {
    const found = header(fixture(name));
    return found?.width !== width || found?.height !== height;
  }).map(([name]) => name);
  check("their stored width and height are read from the header", sizes.length === 0, sizes.join(", "));
  const mimes = FIXTURES.filter(([name, format]) => header(fixture(name))?.mime !== mimeOfFormat(format));
  check("each header carries the media type of the detected format", mimes.length === 0);
  // The first 64 bytes of a non-GIF file are enough to name its format: that is what "sniffing" means.
  const short = FIXTURES.filter(([name, format]) => sniffFormat(bytes(fixture(name)).subarray(0, 64)) !== format).map(([name]) => name);
  check("64 bytes are enough to name the format", short.length === 0, short.join(", "));
}
{
  const text = Buffer.from("This is a text file, whatever its name says.\n");
  check("plain text is not an image", sniffFormat(bytes(text)) === null && header(text) === null);
  check("an empty buffer is not an image", sniffFormat(new Uint8Array(0)) === null && header(Buffer.alloc(0)) === null);
  check("a PDF, a ZIP and an executable are not images", [Buffer.from("%PDF-1.7\n"), Buffer.from([0x50, 0x4b, 3, 4, 20, 0]), Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0])].every((sample) => header(Buffer.concat([sample, Buffer.alloc(64)])) === null));
  check("HTML is not mistaken for SVG", header(Buffer.from("<!doctype html><html><body><p>hello</p></body></html>")) === null);
  const svg = Buffer.from('<?xml version="1.0"?>\n<!-- a comment -->\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80"/></svg>');
  check("an SVG is recognised as a vector image", header(svg)?.format === "svg", JSON.stringify(header(svg)));
  check("a BMP is recognised with its size", header(solidBmp(31, 17))?.format === "bmp" && header(solidBmp(31, 17)).width === 31 && header(solidBmp(31, 17)).height === 17);
  check("a RIFF file that is not WebP (a WAV) is not an image", header(Buffer.concat([Buffer.from("RIFF"), Buffer.from([36, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.alloc(32)])) === null);
  check("an MP4 video is not mistaken for AVIF or HEIC", header(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmp42"), Buffer.from([0, 0, 0, 0]), Buffer.from("mp42isom"), Buffer.alloc(64)])) === null);
}

/* ------------------------------------------------------------- header facts */
section("header facts: rotation, transparency, animation and metadata, without decoding");
{
  const rotated = header(fixture("rotated-gps-240x160.jpg"));
  check("EXIF orientation 6 is read, and the displayed size is the stored size turned", rotated.orientation === 6 && rotated.quarterTurned === true && displayedSize(rotated).width === 160 && displayedSize(rotated).height === 240, JSON.stringify(rotated));
  check("an unrotated photo's displayed size is its stored size", displayedSize(header(fixture("photo-800x600.jpg"))).width === 800 && header(fixture("photo-800x600.jpg")).quarterTurned === false);
  check("EXIF, a GPS block and a colour profile are detected", rotated.metadata.exif && rotated.metadata.gps && rotated.metadata.icc && !rotated.metadata.xmp);
  check("a photo without metadata reports none", Object.values(header(fixture("photo-800x600.jpg")).metadata).every((value) => value === false));
  check("progressive and baseline JPEGs are told apart", header(fixture("progressive-320x240.jpg")).traits.includes("progressive") && header(fixture("photo-800x600.jpg")).traits.includes("baseline"));
  check("JPEG is reported as unable to carry transparency", header(fixture("photo-800x600.jpg")).hasAlpha === false);
  check("an RGBA PNG can carry transparency; a palette PNG without tRNS cannot", header(fixture("alpha-320x200.png")).hasAlpha === true && header(fixture("flat-600x400.png")).hasAlpha === false && header(fixture("flat-600x400.png")).bitDepth === 4);
  check("WebP: the alpha flag and lossless or lossy are read", header(fixture("lossless-alpha-320x200.webp")).hasAlpha === true && header(fixture("lossless-alpha-320x200.webp")).traits.includes("lossless") && header(fixture("lossy-400x300.webp")).hasAlpha === false && header(fixture("lossy-400x300.webp")).traits.includes("lossy"));
  check("AVIF: the alpha plane is detected", header(fixture("alpha-160x100.avif")).hasAlpha === true && header(fixture("small-400x300.avif")).hasAlpha === false);
  const frames = (name) => [header(fixture(name)).animated, header(fixture(name)).frames];
  check("a three-frame GIF and WebP are animated, with their frame count", String(frames("animated-3f-60x40.gif")) === "true,3" && String(frames("animated-3f-60x40.webp")) === "true,3", `${frames("animated-3f-60x40.gif")} ${frames("animated-3f-60x40.webp")}`);
  check("a single-frame GIF is a still image", String(frames("still-200x150.gif")) === "false,1");
  check("an animated PNG is detected from its acTL chunk", header(animatedPng(5)).animated === true && header(animatedPng(5)).frames === 5 && header(solidPng(8, 8)).animated === false);
  check("a two-page TIFF is reported as multi-page", header(fixture("two-page-60x40.tiff")).animated === true && header(fixture("two-page-60x40.tiff")).frames === 2 && header(fixture("image-200x150.tiff")).animated === false);
  check("the pixel count comes from the header", pixelCount(header(fixture("photo-800x600.jpg"))) === 480_000 && pixelCount({ width: null, height: 10 }) === null);
}

/* ------------------------------------------------------ hostile and damaged */
section("hostile and damaged input: nothing is trusted, nothing throws");
{
  const bomb = pngDeclaring(30_000, 30_000);
  check(`a ${bomb.length}-byte PNG that declares 30,000 × 30,000 px is read as exactly that: 900 MP known before any decode`, header(bomb).width === 30_000 && header(bomb).height === 30_000 && pixelCount(header(bomb)) === 900 * MP);
  const huge = pngDeclaring(0x7fffffff, 0x7fffffff);
  check("the largest size a PNG can declare is reported without overflow", header(huge).width === 2_147_483_647 && pixelCount(header(huge)) === 2_147_483_647 * 2_147_483_647);
  const zero = pngDeclaring(0, 600);
  check("a PNG that declares a width of 0 is marked damaged", typeof header(zero)?.malformed === "string", JSON.stringify(header(zero)));
  const photo = fixture("photo-800x600.jpg");
  const cut = header(photo.subarray(0, 120));
  check("a JPEG cut off before its frame header is recognised and marked damaged", cut?.format === "jpeg" && typeof cut.malformed === "string" && cut.width === null, JSON.stringify(cut));
  check("a PNG cut off inside its header is marked damaged", typeof header(solidPng(40, 30).subarray(0, 20))?.malformed === "string");
  check("a WebP cut off after its container header is marked damaged", typeof header(fixture("lossy-400x300.webp").subarray(0, 16))?.malformed === "string");
  check("a GIF cut off inside its header is marked damaged", typeof header(fixture("still-200x150.gif").subarray(0, 8))?.malformed === "string");

  // Every prefix of every fixture, and a few thousand corrupted copies: the parser may say "damaged" or "not an image", but it may never throw or hang.
  let threw = null;
  let cases = 0;
  const started = Date.now();
  const attempt = (sample, label) => {
    cases += 1;
    try {
      const result = readImageHeader(sample);
      if (result !== null && (typeof result.format !== "string" || (result.width !== null && !(Number.isFinite(result.width) && result.width >= 0)))) threw ??= `${label}: invalid result ${JSON.stringify(result)}`;
    } catch (error) {
      threw ??= `${label}: ${error?.message ?? error}`;
    }
  };
  let seed = 0x1234abcd;
  const random = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
  };
  for (const [name] of FIXTURES) {
    const source = bytes(fixture(name));
    const limit = Math.min(source.length, 2_048);
    for (let length = 0; length <= limit; length += 1) attempt(source.subarray(0, length), `${name} cut to ${length}`);
    for (let round = 0; round < 250; round += 1) {
      const copy = source.slice(0, Math.min(source.length, 8_192));
      const flips = 1 + Math.floor(random() * 12);
      for (let flip = 0; flip < flips; flip += 1) copy[Math.floor(random() * Math.min(copy.length, 512))] = Math.floor(random() * 256);
      attempt(copy, `${name} corrupted, round ${round}`);
    }
  }
  for (let round = 0; round < 3_000; round += 1) {
    const noise = new Uint8Array(Math.floor(random() * 300));
    for (let index = 0; index < noise.length; index += 1) noise[index] = Math.floor(random() * 256);
    attempt(noise, `random bytes, round ${round}`);
  }
  check(`${cases.toLocaleString("en-US")} truncated, corrupted and random inputs: no exception, no invalid result`, threw === null, threw ?? "");
  check("and all of them were handled in well under a second each", Date.now() - started < 20_000, `${Date.now() - started} ms`);

  // Structures that point at themselves or far outside the file.
  const loopingTiff = Buffer.alloc(64);
  loopingTiff.write("II", 0, "latin1"); loopingTiff.writeUInt16LE(42, 2); loopingTiff.writeUInt32LE(8, 4);
  loopingTiff.writeUInt16LE(0, 8); loopingTiff.writeUInt32LE(8, 10); // an empty directory whose "next" pointer is itself
  const before = Date.now();
  let looped = null;
  try { looped = header(loopingTiff); } catch (error) { looped = error; }
  check("a TIFF whose directory chain points back at itself ends, quickly", !(looped instanceof Error) && Date.now() - before < 500, String(looped?.message ?? JSON.stringify(looped)));
  const farChunk = Buffer.concat([solidPng(4, 4).subarray(0, 33), Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from("tEXt"), Buffer.alloc(16)]);
  let far = null;
  try { far = header(farChunk); } catch (error) { far = error; }
  check("a chunk that claims 2 GB of data in a 57-byte file is not followed out of bounds", !(far instanceof Error) && far?.width === 4, String(far?.message ?? JSON.stringify(far)));
}

/* --------------------------------------------------------------- inspection */
section("pre-decode check: what a selected file is told, before any pixel exists");
{
  const limits = { maxSourcePixels: 50 * MP };
  const inspect = (data, name, limit = limits) => inspectFile(new Blob([data]), name, limit);
  const ok = await inspect(fixture("photo-800x600.jpg"), "photo.jpg");
  check("a JPEG is accepted with its format, size and media type", ok.ok && ok.source.format === "jpeg" && ok.source.width === 800 && ok.source.height === 600 && ok.source.mime === "image/jpeg" && ok.source.nameMismatch === null, JSON.stringify(ok));
  const rotated = await inspect(fixture("rotated-gps-240x160.jpg"), "IMG_0001.JPG");
  check("a rotated photo is accepted with the size it is shown at, and its GPS block is noted", rotated.ok && rotated.source.width === 160 && rotated.source.height === 240 && rotated.source.orientation === 6 && rotated.source.metadata.gps === true);
  const renamed = await inspect(fixture("alpha-320x200.png"), "holiday.jpg");
  check("a PNG named .jpg is accepted as a PNG, and the mismatch is stated", renamed.ok && renamed.source.format === "png" && /\.jpg/.test(renamed.source.nameMismatch ?? "") && /PNG/.test(renamed.source.nameMismatch ?? ""), JSON.stringify(renamed));
  check("transparency is marked possible for RGBA PNG and impossible for JPEG", renamed.ok && renamed.source.mayHaveAlpha === true && ok.ok && ok.source.mayHaveAlpha === false);

  const refusals = [
    ["an empty file", Buffer.alloc(0), "empty.png", "empty"],
    ["a text file named .jpg", Buffer.from("not an image at all\n".repeat(20)), "photo.jpg", "not_an_image"],
    ["an SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>'), "logo.svg", "vector"],
    ["an animated GIF", fixture("animated-3f-60x40.gif"), "spinner.gif", "animated"],
    ["an animated WebP", fixture("animated-3f-60x40.webp"), "spinner.webp", "animated"],
    ["an animated PNG", animatedPng(3), "spinner.png", "animated"],
    ["a multi-page TIFF", fixture("two-page-60x40.tiff"), "scan.tiff", "animated"],
    ["a truncated JPEG", fixture("photo-800x600.jpg").subarray(0, 120), "cut.jpg", "damaged"],
    ["a PNG declaring 30,000 × 30,000 px", pngDeclaring(30_000, 30_000), "bomb.png", "too_many_pixels"],
  ];
  for (const [label, data, name, code] of refusals) {
    const result = await inspect(data, name);
    check(`${label} is refused (${code}), with a message and a next step`, result.ok === false && result.code === code && result.message.length > 10 && result.hint.length > 20, JSON.stringify(result));
  }
  const bomb = await inspect(pngDeclaring(30_000, 30_000), "bomb.png");
  check("the refusal of the oversized PNG states its size and the memory a decode would need", !bomb.ok && /30,000 × 30,000/.test(bomb.message) && /900 MP/.test(bomb.message) && /3,433 MB/.test(bomb.message), bomb.message);
  const edge = solidPng(100, 100);
  const exactly = await inspect(edge, "edge.png", { maxSourcePixels: 10_000 });
  const over = await inspect(edge, "edge.png", { maxSourcePixels: 9_999 });
  check("the pixel limit is exact: an image at the limit is accepted, one pixel over is refused", exactly.ok === true && over.ok === false && over.code === "too_many_pixels");
  const turned = await inspect(fixture("rotated-gps-240x160.jpg"), "r.jpg", { maxSourcePixels: 240 * 160 });
  check("rotation does not change the pixel count used for the limit", turned.ok === true);
  check("a still GIF and a BMP are accepted", (await inspect(fixture("still-200x150.gif"), "a.gif")).ok && (await inspect(solidBmp(20, 10), "a.bmp")).ok);

  // The check must not read whole files: only the head, and for a GIF as much as it takes to count frames.
  let read = 0;
  const big = new Blob([fixture("photo-800x600.jpg"), new Uint8Array(6 * 1024 * 1024)]);
  const spy = { size: big.size, slice: (start, end) => { const part = big.slice(start, end); read += part.size; return part; } };
  const spied = await inspectFile(spy, "big.jpg", limits);
  check(`of a ${(big.size / 1024 / 1024).toFixed(1)} MB file, only the first megabyte is read`, spied.ok && read === HEAD_BYTES, `${read} bytes read`);
  const unreadable = await inspectFile({ size: 10, slice: () => ({ arrayBuffer: async () => { throw new Error("NotReadableError"); } }) }, "gone.jpg", limits);
  check("a file the browser can no longer read is reported as such, not as a crash", unreadable.ok === false && unreadable.code === "unreadable");

  check("extensions map to formats, case-insensitively, and unknown ones to nothing", formatFromName("A.JPG") === "jpeg" && formatFromName("b.jfif") === "jpeg" && formatFromName("c.heif") === "heic" && formatFromName("d.tif") === "tiff" && formatFromName("e.txt") === null && formatFromName("noextension") === null);
}

/* ------------------------------------------------------------------- limits */
section("device limits: the only limits there are, since no server is involved");
{
  const low = plan.resolveEngineLimits({ deviceMemory: 2, cores: 4 });
  const mid = plan.resolveEngineLimits({ deviceMemory: 4, cores: 8 });
  const high = plan.resolveEngineLimits({ deviceMemory: 8, cores: 16 });
  check("source pixels: 24 MP, 50 MP and 100 MP by device memory", low.maxSourcePixels === 24 * MP && mid.maxSourcePixels === 50 * MP && high.maxSourcePixels === 100 * MP);
  check("AVIF output: 8, 24 and 40 MP; as one of several candidates: 4, 12 and 24 MP", [low, mid, high].map((tier) => tier.avifMaxPixels / MP).join() === "8,24,40" && [low, mid, high].map((tier) => tier.avifCandidateMaxPixels / MP).join() === "4,12,24");
  check("files in work at once: 1, 2 and 4", low.concurrency === 1 && mid.concurrency === 2 && high.concurrency === 4);
  check("one core is left to the page: 2 cores give 1 worker, 3 cores give 2", plan.resolveEngineLimits({ deviceMemory: 8, cores: 2 }).concurrency === 1 && plan.resolveEngineLimits({ deviceMemory: 8, cores: 3 }).concurrency === 2);
  check("a single-core device still gets one worker", plan.resolveEngineLimits({ deviceMemory: 8, cores: 1 }).concurrency === 1);
  check("unknown memory counts as 8 GB, and as 4 GB on a phone", plan.resolveEngineLimits({ cores: 8 }).maxSourcePixels === 100 * MP && plan.resolveEngineLimits({ cores: 8, mobile: true }).maxSourcePixels === 50 * MP);
  check("nonsense hints fall back to safe values", plan.resolveEngineLimits({ deviceMemory: -1, cores: 0 }).concurrency === 1 && plan.resolveEngineLimits({ deviceMemory: Number.NaN, cores: Number.NaN }).maxSourcePixels === 100 * MP && plan.resolveEngineLimits().concurrency === 1);
  check("the queue holds at most 300 files, and the pixel budget equals the source limit", [low, mid, high].every((tier) => tier.maxFiles === 300 && tier.pixelBudget === tier.maxSourcePixels));
}

/* -------------------------------------------------------------------- sizes */
section("output size: fitted inside the limits, proportions kept, never enlarged");
{
  const size = (...args) => { const out = plan.targetSize(...args); return `${out.width}x${out.height}${out.resized ? "*" : ""}`; };
  check("no limit leaves the size alone", size(800, 600, null, null) === "800x600");
  check("a width limit scales both sides", size(800, 600, 200, null) === "200x150*");
  check("a height limit scales both sides", size(800, 600, null, 300) === "400x300*");
  check("with both limits the tighter one decides", size(800, 600, 600, 300) === "400x300*" && size(800, 600, 300, 600) === "300x225*");
  check("a limit above the image's size does not enlarge it", size(160, 100, 1920, null) === "160x100" && size(160, 100, 1920, 1080) === "160x100");
  check("a limit equal to the size changes nothing", size(800, 600, 800, 600) === "800x600");
  check("an extreme ratio never rounds a side down to 0", size(10_000, 3, 100, null) === "100x1*");
  let violations = 0;
  for (let width = 1; width <= 400; width += 7) for (let height = 1; height <= 400; height += 11) for (const maxWidth of [null, 16, 33, 100, 257]) for (const maxHeight of [null, 16, 41, 99]) {
    const out = plan.targetSize(width, height, maxWidth, maxHeight);
    if (out.width < 1 || out.height < 1 || out.width > width || out.height > height || (maxWidth && out.width > maxWidth) || (maxHeight && out.height > maxHeight)) violations += 1;
  }
  check("over 40,000 combinations: no output exceeds a limit or its source, and none is empty", violations === 0, `${violations} violations`);
}

/* --------------------------------------------------------------- candidates */
section("strategies: what each one tries");
{
  const limits = { avifMaxPixels: 24 * MP, avifCandidateMaxPixels: 12 * MP };
  const candidates = (settings, source = { format: "jpeg" }, output = { width: 800, height: 600 }) => plan.planCandidates({ quality: 78, ...settings }, source, output, limits);
  const formats = (set) => (set.ok ? set.candidates.map((candidate) => candidate.format).join() : `refused: ${set.message}`);
  check("single writes exactly the chosen format", ["webp", "avif", "jpeg", "png"].every((format) => formats(candidates({ strategy: "single", format })) === format));
  check("single with \"keep format\" writes the source's own format", formats(candidates({ strategy: "single", format: "original" }, { format: "png" })) === "png" && formats(candidates({ strategy: "single", format: "original" }, { format: "avif" })) === "avif");
  const gif = candidates({ strategy: "single", format: "original" }, { format: "gif" });
  check("\"keep format\" for a format no browser can write is refused with a next step", gif.ok === false && /GIF/.test(gif.message) && gif.hint.length > 10, JSON.stringify(gif));
  check("best-effort and no-regression compare WebP, AVIF and JPEG", formats(candidates({ strategy: "best-effort", format: "png" })) === "webp,avif,jpeg" && formats(candidates({ strategy: "no-regression", format: "webp" })) === "webp,avif,jpeg");
  const multi = candidates({ strategy: "best-effort", format: "webp" });
  check("only JPEG is conditional on the image being opaque", multi.ok && multi.candidates.filter((candidate) => candidate.requiresOpaque).map((candidate) => candidate.format).join() === "jpeg");
  check("every candidate uses the chosen quality, and says so", multi.ok && multi.candidates.every((candidate) => candidate.quality === 78 && /quality 78/.test(candidate.note)));
  const large = candidates({ strategy: "best-effort", format: "webp" }, { format: "jpeg" }, { width: 5_000, height: 3_000 });
  check("above the AVIF comparison limit, AVIF is left out and the reason is recorded", formats(large) === "webp,jpeg" && large.ok && large.skipped.length === 1 && large.skipped[0].format === "avif" && /12 MP/.test(large.skipped[0].note), JSON.stringify(large));
  const avifTooLarge = candidates({ strategy: "single", format: "avif" }, { format: "jpeg" }, { width: 6_000, height: 4_001 });
  check("single AVIF above the device's AVIF limit is refused before any work, with the limit named", avifTooLarge.ok === false && /24 MP/.test(avifTooLarge.message) && /WebP/.test(avifTooLarge.hint), JSON.stringify(avifTooLarge));
  check("single AVIF exactly at the limit is allowed", candidates({ strategy: "single", format: "avif" }, { format: "jpeg" }, { width: 6_000, height: 4_000 }).ok === true);
  const wide = candidates({ strategy: "single", format: "webp" }, { format: "png" }, { width: 16_384, height: 100 });
  check("WebP cannot store a side above 16,383 px: single is refused, a comparison leaves it out", wide.ok === false && /16,383/.test(wide.message) && formats(candidates({ strategy: "best-effort", format: "webp" }, { format: "png" }, { width: 16_384, height: 100 })) === "avif,jpeg");
  check("PNG is described as lossless, without a quality", candidates({ strategy: "single", format: "png" }).candidates[0].note === "lossless PNG");
}

/* ---------------------------------------------------------------- selection */
section("selection: the smallest real file wins; no-regression never returns a larger one");
{
  const blob = (size) => (size === null ? { blob: null } : { blob: new Blob([new Uint8Array(size)]) });
  const pick = (strategy, sourceBytes, sizes) => plan.selectOutcome(strategy, sourceBytes, sizes.map(blob));
  check("best-effort picks the smallest candidate", pick("best-effort", 1_000, [500, 300, 700]).chosen === 1);
  check("best-effort returns the smallest even when it is larger than the source: the interface then says so", pick("best-effort", 100, [500, 300, 700]).chosen === 1 && pick("best-effort", 100, [500, 300, 700]).keptOriginal === false);
  check("a tie goes to the first candidate", pick("best-effort", 1_000, [400, 400, 400]).chosen === 0);
  check("candidates that could not be encoded are ignored", pick("best-effort", 1_000, [null, 600, null]).chosen === 1);
  check("when nothing could be encoded, best-effort and single have no result", pick("best-effort", 1_000, [null, null]) === null && pick("single", 1_000, [null]) === null);
  check("no-regression picks the smallest when it is smaller than the source", pick("no-regression", 1_000, [900, 999, 1_200]).chosen === 0 && pick("no-regression", 1_000, [1_200, 999]).chosen === 1);
  const equal = pick("no-regression", 1_000, [1_000, 1_500]);
  check("no-regression keeps the original when the best result is exactly as large", equal.chosen === "original" && equal.keptOriginal === true && /at least as large/.test(equal.keptReason));
  check("no-regression keeps the original when every result is larger", pick("no-regression", 670, [1_438, 4_994]).chosen === "original");
  const none = pick("no-regression", 1_000, [null, null]);
  check("no-regression keeps the original when nothing could be encoded, and says why", none.chosen === "original" && /No format could be encoded/.test(none.keptReason));
  let regressions = 0;
  let seed = 7;
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 5_000; round += 1) {
    const source = 1 + Math.floor(next() * 5_000);
    const sizes = Array.from({ length: 1 + Math.floor(next() * 3) }, () => (next() < 0.15 ? null : 1 + Math.floor(next() * 10_000)));
    const choice = pick("no-regression", source, sizes);
    const size = choice.chosen === "original" ? source : sizes[choice.chosen];
    const smallest = Math.min(...sizes.filter((value) => value !== null), Number.POSITIVE_INFINITY);
    if (size > source || (smallest < source && size !== smallest)) regressions += 1;
  }
  check("5,000 random cases: no-regression never returns more bytes than the source, and never misses a smaller result", regressions === 0, `${regressions} violations`);
}

/* ------------------------------------------------------------------ metrics */
section("metrics: computed from two byte counts, nothing else");
{
  const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
  check("164,543 → 90,174 bytes is 74,369 saved, 45.2%", same(plan.savings(164_543, 90_174), { savedBytes: 74_369, savingsPercent: 45.2, grew: false }));
  check("670 → 4,994 bytes is reported as growth: −4,324 bytes, −645.4%", same(plan.savings(670, 4_994), { savedBytes: -4_324, savingsPercent: -645.4, grew: true }));
  check("equal sizes are 0 saved and not growth", same(plan.savings(500, 500), { savedBytes: 0, savingsPercent: 0, grew: false }));
  check("an empty input does not divide by zero", same(plan.savings(0, 10), { savedBytes: -10, savingsPercent: 0, grew: true }));
  check("bytes are shown on a 1,024 ladder", formatBytes(670) === "670 B" && formatBytes(164_543) === "160.7 KB" && formatBytes(90_174) === "88.1 KB" && formatBytes(5 * 1024 * 1024) === "5 MB" && formatBytes(0) === "0 B");
  check("a saving is shown with its sign", formatSavingsPercent(45.2) === "+45.2%" && formatSavingsPercent(-645.4) === "-645.4%" && formatSavingsPercent(0) === "0%");
}

/* ------------------------------------------------------------------- naming */
section("names: safe to save anywhere, and never the source's own name");
{
  check("photo.jpg becomes photo-optimized.webp, .avif, .jpg or .png", ["webp", "avif", "jpeg", "png"].map((format) => plan.outputFilename("photo.jpg", format)).join() === "photo-optimized.webp,photo-optimized.avif,photo-optimized.jpg,photo-optimized.png");
  check("converting a JPEG to JPEG still gets a different name, so the source is not overwritten", plan.outputFilename("photo.jpg", "jpeg") !== "photo.jpg");
  check("only the last extension is replaced", plan.outputFilename("archive.tar.png", "webp") === "archive.tar-optimized.webp");
  check("a name without an extension works", plan.outputFilename("README", "png") === "README-optimized.png");
  check("a path is reduced to its last part", plan.sanitizeFilename("../../etc/passwd") === "passwd" && plan.sanitizeFilename("C:\\Users\\me\\photo.png") === "photo.png");
  check("control characters and characters Windows forbids are replaced", plan.sanitizeFilename('a<b>c:d"e|f?g*h\u0000i\u001fj.png') === "a_b_c_d_e_f_g_h_i_j.png", plan.sanitizeFilename('a<b>c:d"e|f?g*h\u0000i\u001fj.png'));
  check("spaces become hyphens and leading dots are dropped", plan.sanitizeFilename("my holiday photo.jpg") === "my-holiday-photo.jpg" && plan.sanitizeFilename("...hidden.png") === "hidden.png");
  check("a name is at most 80 characters, and never empty", plan.sanitizeFilename(`${"x".repeat(300)}.png`).length === 80 && plan.sanitizeFilename("") === "image" && plan.sanitizeFilename("...") === "image" && plan.sanitizeFilename("/") === "image");
  check("non-Latin names are kept", plan.outputFilename("фото-отпуск.png", "webp") === "фото-отпуск-optimized.webp" && plan.outputFilename("写真.jpeg", "avif") === "写真-optimized.avif");
}

/* --------------------------------------------------------------- scheduling */
section("scheduling: bounded concurrency, a pixel budget, and no file overtaken");
{
  const limits = { concurrency: 2, pixelBudget: 50 * MP };
  const job = (id, megapixels) => ({ id, pixels: megapixels * MP });
  const start = (waiting, running, cap = limits) => plan.nextToStart(waiting, running, cap).join();
  check("with two workers free, the first two waiting files start", start([job("a", 1), job("b", 1), job("c", 1)], []) === "a,b");
  check("with one worker busy, one more starts", start([job("b", 1), job("c", 1)], [job("a", 1)]) === "b");
  check("with all workers busy, nothing starts", start([job("c", 1)], [job("a", 1), job("b", 1)]) === "");
  check("a file that does not fit in the remaining pixel budget waits", start([job("b", 30)], [job("a", 30)]) === "");
  check("and the files behind it wait too: order is kept", start([job("b", 30), job("c", 1)], [job("a", 30)]) === "");
  check("two files that fit together start together", start([job("a", 25), job("b", 25)], []) === "a,b");
  check("a file larger than the whole budget runs alone, not never", start([job("a", 80), job("b", 1)], []) === "a" && start([job("a", 80)], [job("x", 1)]) === "");
  check("with concurrency 1 a single file starts", start([job("a", 1), job("b", 1)], [], { concurrency: 1, pixelBudget: 50 * MP }) === "a");
  check("nothing waiting, nothing started", start([], []) === "");

  const ms = (source, output, formats) => plan.jobTimeoutMs(source * MP, output * MP, formats);
  check("a time limit grows with the pixels and with every format tried", ms(1, 1, ["webp"]) === 34_000 && ms(12, 12, ["webp"]) === 78_000 && ms(12, 12, ["webp", "avif", "jpeg"]) === 180_000, `${ms(1, 1, ["webp"])} ${ms(12, 12, ["webp"])} ${ms(12, 12, ["webp", "avif", "jpeg"])}`);
  check("AVIF gets more time per pixel than the other formats", ms(12, 12, ["avif"]) > ms(12, 12, ["webp"]) && ms(12, 12, ["avif"]) === 120_000);
  check("no file may run for more than fifteen minutes", ms(100, 100, ["webp", "avif", "jpeg"]) === 15 * 60_000);
}

/* ----------------------------------------------------------------- settings */
section("settings: every value is validated before it is used");
{
  check("quality is kept inside 30–100 and rounded", plan.clampQuality(5) === 30 && plan.clampQuality(1e9) === 100 && plan.clampQuality(77.6) === 78 && plan.clampQuality(Number.NaN) === 78);
  check("a size limit is null for \"none\", otherwise inside 16–16,000 px", plan.clampDimension(null) === null && plan.clampDimension(0) === null && plan.clampDimension(-5) === null && plan.clampDimension(Number.NaN) === null && plan.clampDimension(3) === 16 && plan.clampDimension(99_999) === 16_000 && plan.clampDimension(1280.4) === 1280);
  check("only the five format choices are accepted", ["webp", "avif", "jpeg", "png", "original"].every(plan.isFormatChoice) && !["gif", "", null, 5, "WEBP", "auto"].some(plan.isFormatChoice));
  const junk = normalizePreferences({ defaultImageFormat: "bmp", defaultStrategy: "target-size", defaultQuality: 5, defaultMaxWidth: 99_999, fontDisplayPolicy: "sometimes", analyzerThresholdKb: -5, reduceMotion: "yes" });
  check("invalid stored settings fall back field by field", junk.defaultImageFormat === "webp" && junk.defaultStrategy === "single" && junk.defaultQuality === 30 && junk.defaultMaxWidth === 16_000 && junk.fontDisplayPolicy === "swap" && junk.analyzerThresholdKb === 300 && junk.reduceMotion === false, JSON.stringify(junk));
  check("the strategy of the earlier version that no longer exists falls back to single", normalizePreferences({ defaultStrategy: "target-size" }).defaultStrategy === "single");
  check("storage that holds something else entirely gives the defaults", [null, undefined, "text", 5, [], { nested: {} }].every((raw) => JSON.stringify(normalizePreferences(raw)) === JSON.stringify(DEFAULT_PREFERENCES)));
  const valid = { defaultImageFormat: "avif", defaultStrategy: "no-regression", defaultQuality: 60, defaultMaxWidth: 1600, fontDisplayPolicy: "optional", analyzerThresholdKb: 500, reduceMotion: true };
  check("valid settings pass through unchanged", JSON.stringify(normalizePreferences(valid)) === JSON.stringify(valid));
  check("the browser storage keys carry the product's name", storageKeys.THEME_STORAGE_KEY === "unikit:theme" && storageKeys.PREFERENCES_STORAGE_KEY === "unikit:preferences" && storageKeys.CSS_DRAFT_STORAGE_KEY === "unikit:css-draft");
}

/* ---------------------------------------------------------------------- css */
section("stylesheets: @font-face rules are found and patched by a real CSS parser");
{
  const css = [
    "@font-face {",
    "  font-family: \"Inter\";",
    "  src: url(inter.woff2) format(\"woff2\");",
    "}",
    "",
    "@font-face { font-family: Mono; src: url(mono.woff2); font-display: optional }",
    "",
    "body { font-family: Inter, sans-serif; }",
    "",
  ].join("\n");
  const analysis = analyzeCss(css, "swap");
  check("two rules are found: one with font-display, one without", analysis.fontFaceCount === 2 && analysis.withFontDisplay === 1 && analysis.missingFontDisplay === 1 && analysis.parseErrors.length === 0, JSON.stringify(analysis));
  check("the finding names the family and the line", analysis.findings.some((finding) => finding.code === "font-display-missing" && finding.line === 1 && /Inter/.test(`${finding.title} ${finding.detail} ${finding.selector ?? ""}`)), JSON.stringify(analysis.findings));
  const patch = patchFontDisplay(css, "swap");
  check("the patch adds font-display: swap to the rule that lacked it", /src: url\(inter\.woff2\) format\("woff2"\);\n\s*font-display: swap/.test(patch.output) && patch.rulesPatched.length === 1 && patch.rulesPatched[0].family === "Inter" && patch.rulesPatched[0].line === 1, patch.output);
  check("the rule that already had a value keeps it", patch.output.includes("font-display: optional") && (patch.output.match(/font-display/g) ?? []).length === 2);
  check("every other line is unchanged", css.split("\n").every((line) => patch.output.split("\n").includes(line)) && patch.changedLines.length === 1 && patch.output.split("\n")[patch.changedLines[0] - 1].includes("font-display: swap"), JSON.stringify(patch.changedLines));
  check("the byte counts are the real sizes of both texts", patch.inputBytes === Buffer.byteLength(css) && patch.outputBytes === Buffer.byteLength(patch.output) && patch.outputBytes > patch.inputBytes);
  const again = patchFontDisplay(patch.output, "swap");
  check("patching twice changes nothing the second time", again.output === patch.output && again.rulesPatched.length === 0 && again.changedLines.length === 0);
  check("the chosen policy is the one written", /font-display: fallback/.test(patchFontDisplay(css, "fallback").output));
  const noSrc = patchFontDisplay("@font-face { font-family: Broken; }", "swap");
  check("a rule without src is reported and not patched", noSrc.rulesPatched.length === 0 && noSrc.output === "@font-face { font-family: Broken; }" && noSrc.analysis.findings.some((finding) => finding.code === "font-face-no-src"), JSON.stringify(noSrc.analysis.findings));
  const nested = patchFontDisplay("@media (min-width: 600px) { @font-face { font-family: N; src: url(n.woff2) } }", "swap");
  check("a rule nested in @media is found and patched", nested.rulesPatched.length === 1 && /font-display: swap/.test(nested.output));
  const upper = analyzeCss("@FONT-FACE { font-family: U; src: url(u.woff2); FONT-DISPLAY: swap }", "swap");
  check("the at-rule and the property are matched case-insensitively", upper.fontFaceCount === 1 && upper.withFontDisplay === 1);
  const inComment = analyzeCss("/* @font-face { font-family: C; src: url(c.woff2) } */ a { content: \"@font-face { }\" }", "swap");
  check("text inside comments and strings is not a rule", inComment.fontFaceCount === 0 && inComment.findings.some((finding) => finding.code === "no-font-face"));
  const broken = patchFontDisplay("@font-face { font-family: X; src: url(x.woff2) ", "swap");
  check("a stylesheet that does not parse is returned untouched, with the parse error", broken.output === "@font-face { font-family: X; src: url(x.woff2) " && broken.analysis.parseErrors.length === 1 && broken.rulesPatched.length === 0, JSON.stringify(broken.analysis.parseErrors));
  const thrown = (run) => { try { run(); return null; } catch (error) { return error; } };
  check("empty input is refused by name", thrown(() => analyzeCss("   \n", "swap")) instanceof CssInputError && thrown(() => analyzeCss("", "swap")).code === "empty");
  check("input above the size limit is refused before it is parsed", thrown(() => analyzeCss("a{}".repeat(Math.ceil(MAX_CSS_CHARS / 3) + 1), "swap"))?.code === "too_large");
  check("UTF-8 sizes count bytes, not characters", utf8Bytes("é") === 2 && utf8Bytes("写真") === 6 && utf8Bytes("a") === 1);
  check("the gap count used by the Asset Analyzer agrees", JSON.stringify(countFontDisplayGaps(css)) === JSON.stringify({ total: 2, missing: 1 }) && countFontDisplayGaps("@font-face { src: url(x) ") === null);
  check("a script-like payload in a stylesheet is data, never executed or reflected as markup", (() => { const hostile = patchFontDisplay('@font-face { font-family: "</style><script>alert(1)</script>"; src: url(x.woff2) }', "swap"); return hostile.rulesPatched.length === 1 && hostile.output.includes("<script>alert(1)</script>") && /font-display: swap/.test(hostile.output); })());
}

/* ------------------------------------------------------------------- assets */
section("asset analysis: facts from file headers; thresholds are labelled as such");
{
  const asset = (filename, data, text = null) => ({ filename, bytes: data.length, head: bytes(data).subarray(0, 1024 * 1024), text });
  const css = "@font-face { font-family: A; src: url(a.woff2) }";
  const analysis = analyzeAssets([
    asset("photo.jpg", fixture("photo-800x600.jpg")),
    asset("IMG_0001.jpg", fixture("rotated-gps-240x160.jpg")),
    asset("spinner.png", animatedPng(4)),
    asset("site.css", Buffer.from(css), css),
    asset("notes.jpg", Buffer.from("just some text")),
    asset("empty.png", Buffer.alloc(0)),
    asset("renamed.jpg", fixture("alpha-320x200.png")),
  ], { thresholdKb: 100 });
  const [photo, rotated, spinner, sheet, notes, empty, renamed] = analysis.files;
  const codes = (report) => report.findings.map((finding) => finding.code);
  check("an image is reported with its format and size from the header", photo.kind === "image" && photo.format === "jpeg" && photo.width === 800 && photo.height === 600 && photo.bytes === 164_543 && photo.optimizable === true, JSON.stringify(photo));
  check("a file above the threshold is flagged, and the finding is marked as a threshold comparison", codes(photo).includes("large-file") && photo.findings.find((finding) => finding.code === "large-file").heuristic === true, JSON.stringify(photo.findings));
  check("a rotated photo is reported at its displayed size, and its GPS block is flagged as a fact", rotated.width === 160 && rotated.height === 240 && codes(rotated).includes("location-data") && rotated.findings.find((finding) => finding.code === "location-data").heuristic === false, JSON.stringify(rotated));
  check("an animated PNG is flagged as animated and is not offered to the optimizer", codes(spinner).includes("animated") && spinner.optimizable === false, JSON.stringify(spinner));
  check("a stylesheet's missing font-display is found", sheet.kind === "css" && codes(sheet).includes("font-display-missing") && sheet.optimizable === false, JSON.stringify(sheet));
  check("text with an image's name is reported as not recognised", notes.kind === "other" && notes.format === null && codes(notes).join() === "unrecognised" && notes.optimizable === false);
  check("an empty file is reported as empty", codes(empty).join() === "unrecognised" && /empty/.test(empty.findings[0].evidence));
  check("a PNG named .jpg is reported as a PNG, with the mismatch", renamed.format === "png" && codes(renamed).includes("name-mismatch"), JSON.stringify(renamed));
  check("the summary counts what was found", analysis.summary.filesScanned === 7 && analysis.summary.issues >= 2 && analysis.summary.heuristicsUsed === true && analysis.summary.findings === analysis.files.flatMap((file) => file.findings).filter((finding) => finding.severity !== "info").length, JSON.stringify(analysis.summary));
  const quiet = analyzeAssets([asset("photo.jpg", fixture("photo-800x600.jpg"))], { thresholdKb: 10_000 });
  check("below the threshold the same file is not flagged as large", !quiet.files[0].findings.some((finding) => finding.code === "large-file"));
  const scripted = analyzeAssets([asset("logo.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))]);
  check("an SVG that contains a script is flagged", scripted.files[0].format === "svg" && scripted.files[0].findings.some((finding) => finding.code === "svg-script"), JSON.stringify(scripted.files[0].findings));
  const garbage = analyzeAssets([asset("x.png", solidPng(8, 8).subarray(0, 20)), asset("y.css", Buffer.from("@font-face { src: url(x) "), "@font-face { src: url(x) ")]);
  check("a damaged image and a stylesheet that does not parse become findings, not exceptions", garbage.files[0].findings.some((finding) => finding.code === "damaged") && garbage.files[1].findings.some((finding) => finding.code === "css-syntax"), JSON.stringify(garbage.files.map((file) => file.findings.map((finding) => finding.code))));
  check("no finding text contains markup taken from a file name", analyzeAssets([asset('<img src=x onerror=alert(1)>.png', Buffer.from("x"))]).files[0].findings.every((finding) => !/<img/.test(finding.evidence + finding.recommendation)));
}

const ok = report();
if (ok) console.log("\nAll core checks passed.");
process.exit(ok ? 0 : 1);
