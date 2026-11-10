#!/usr/bin/env node
/**
 * Self-test of the Image Optimizer screen in a DOM. Needs no browser and no
 * database.
 *
 *   npm run test:dom
 *
 * It mounts the real screen in jsdom and uses it the way a person does: choose
 * files, press "Optimize", then download. Requests go to the real API, started
 * in this process without a database, so nothing can be stored and every
 * converted file has to come back with the response.
 *
 *  - The results say "Converted, but not stored" and offer each file from a
 *    blob: URL held in the tab. The file behind the link is decoded and
 *    compared with what the result reports. No stored download, Inspect link
 *    or History link appears.
 *  - "Download all (ZIP)" bundles those copies without a request, and each
 *    entry is byte-identical to the file behind its link.
 *  - Removing a file, and leaving the page, release the copies.
 *  - On a site that is deployed without its API (the host answers /api with
 *    its own "not found" page), the screen says that the API is not available
 *    on this site, keeps the queue, and offers nothing.
 *
 * jsdom is not a browser: it does not lay out, paint or save files. This test
 * covers what the screen requests, shows and links to, not how it looks.
 */
import http from "node:http";
import path from "node:path";
import { resolveObjectURL } from "node:buffer";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import JSZip from "jszip";
import sharp from "sharp";
import { createChecker, jpegImage, pngImage, startApi } from "./lib/selftest-kit.mjs";

if (process.env.MONGODB_URI || process.env.MONGO_URL) {
  console.error("Refusing to run: this test covers the screen without a database. Unset MONGODB_URI and MONGO_URL.");
  process.exit(2);
}

const { check, section, report, crashed } = createChecker("optimizer-dom-selftest");
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ the DOM */
// The page gets a document and its element classes from jsdom. `fetch`,
// `FormData`, `File`, `Blob` and `URL` stay Node's own, so uploads and object
// URLs are real.
const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => pageErrors.push(String(error?.message ?? error)));
const { window } = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/app/images", pretendToBeVisual: true, virtualConsole });
for (const name of ["window", "document", "navigator", "location", "history", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLAnchorElement", "SVGElement", "DocumentFragment", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true });
}
const { document } = window;

// Every object URL the page creates, until the page releases it.
const held = new Map();
const createObjectUrl = URL.createObjectURL.bind(URL);
const revokeObjectUrl = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => { const url = createObjectUrl(blob); held.set(url, blob); return url; };
URL.revokeObjectURL = (url) => { held.delete(url); revokeObjectUrl(url); };

// A ZIP is saved by clicking a temporary link. jsdom cannot save files, so
// record what would have been saved.
const saved = [];
window.HTMLAnchorElement.prototype.click = function click() {
  saved.push({ name: this.download, blob: held.get(this.href) ?? null });
};

/* ---------------------------------------------------------------- the hosts */
const api = await startApi();
// A host without the API: every /api path gets the host's own "not found" page.
const hostWithoutApi = http.createServer((req, res) => {
  req.resume();
  res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>404: NOT_FOUND</title><h1>This page doesn't exist</h1>");
});
hostWithoutApi.listen(0, "127.0.0.1");
await once(hostWithoutApi, "listening");

// The page requests same-origin paths. Send them to the host under test, and
// keep a copy of each answer to an upload, to compare the page with it.
let host = api.base;
const requests = [];
const uploadAnswers = [];
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const isPath = typeof input === "string" && input.startsWith("/");
  requests.push(`${init?.method ?? "GET"} ${isPath ? input : "(other)"}`);
  const response = await nodeFetch(isPath ? `${host}${input}` : input, init);
  if (input === "/api/v1/images/optimize") uploadAnswers.push(response.clone().json().catch(() => null));
  return response;
};

/* --------------------------------------------------------------- the screen */
const { createServer } = await import("vite");
// `envDir` points at a directory without .env files, so a developer's local
// VITE_API_BASE_URL cannot redirect the requests of this test.
const vite = await createServer({
  root: appDir,
  envDir: path.join(appDir, "scripts", "lib"),
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const { mountImageOptimizer } = await vite.ssrLoadModule("/scripts/lib/mount-image-optimizer.tsx");
const mount = () => mountImageOptimizer(document.getElementById("root"), { maxFileMb: 1, maxFiles: 4, maxDecodedPixels: 24_000_000, avifSupported: false });

const pageText = () => document.body.textContent.replace(/\s+/g, " ");
const pageHtml = () => document.body.innerHTML;
async function waitFor(condition, timeoutMs = 15_000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (condition()) return true;
    await sleep(20);
  }
  return condition();
}
const buttonLabels = () => Array.from(document.querySelectorAll("button")).map((element) => (element.getAttribute("aria-label") ?? element.textContent).trim());
const findButton = (label) => Array.from(document.querySelectorAll("button")).find((element) => (element.getAttribute("aria-label") ?? element.textContent).trim() === label) ?? null;
/** Clicks the button with exactly this label. False when there is none. */
function press(label) {
  const element = findButton(label);
  element?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  return element !== null;
}
/** Puts files into the file picker, as choosing them in the dialog does. */
function chooseFiles(files) {
  const input = document.querySelector('input[type="file"]');
  if (!input) return false;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  return true;
}
/** Download links on the page, one per file name. */
function downloads() {
  const byName = new Map();
  for (const anchor of document.querySelectorAll("a[download]")) byName.set(anchor.getAttribute("download"), anchor.getAttribute("href") ?? "");
  return byName;
}
const allDownloadsAreTabCopies = () => Array.from(document.querySelectorAll("a[download]")).every((anchor) => (anchor.getAttribute("href") ?? "").startsWith("blob:"));
async function fileBehind(url) {
  const blob = url ? resolveObjectURL(url) : undefined;
  return blob ? Buffer.from(await blob.arrayBuffer()) : null;
}
const imageFile = (data, name, type) => new File([data], name, { type });

const photo = await jpegImage(320, 200, { r: 36, g: 92, b: 230 });
const red = await pngImage(64, 48, { r: 200, g: 30, b: 30 });
const green = await pngImage(80, 20, { r: 10, g: 160, b: 60 });

/* ----------------------------------------- 1. one file, nothing can be stored */
section("one file, API without a database: convert, then download from the tab");
let screen = mount();
await waitFor(() => document.querySelector('input[type="file"]') !== null);
chooseFiles([imageFile(photo, "photo.jpg", "image/jpeg")]);
check("the file is queued and the button reads \"Optimize 1 file\"", await waitFor(() => findButton("Optimize 1 file") !== null), buttonLabels().join(" | "));
press("Optimize 1 file");
check("the results say: converted, but not stored", await waitFor(() => pageText().includes("Converted, but not stored")), pageText().slice(0, 300));
check("one upload request was sent", requests.filter((request) => request === "POST /api/v1/images/optimize").length === 1, requests.join(", "));
{
  const links = downloads();
  const url = links.get("photo-optiweb.webp");
  check("the file is offered for download, from a blob: URL held in the tab", links.size === 1 && Boolean(url) && allDownloadsAreTabCopies(), JSON.stringify([...links]));
  const file = await fileBehind(url);
  const image = file ? await sharp(file).metadata().catch(() => null) : null;
  check("the file behind the link is the converted image: WebP, 320×200, smaller than the upload", image?.format === "webp" && image.width === 320 && image.height === 200 && file.length < photo.length, `${file?.length ?? 0} bytes, ${image?.format ?? "not an image"}`);
  const sent = (await uploadAnswers[0])?.data?.results?.[0];
  check("it is byte-identical to the file the API sent, and as large as the result reports", file !== null && typeof sent?.inlineOutput?.data === "string" && file.equals(Buffer.from(sent.inlineOutput.data, "base64")) && file.length === sent.outputBytes, `${file?.length ?? 0} bytes behind the link, ${sent?.outputBytes} reported`);
  check("the result preview is read from the same copy", Array.from(document.querySelectorAll("img")).some((img) => img.getAttribute("src") === url));
  check("the wording says the copy exists only in this tab and the run is not in History", pageText().includes("the copy exists only in this tab") && pageText().includes("This run is not in History.") && pageText().includes("Not stored. This copy is kept only in this tab."));
  check("no stored download, Inspect link or History link is offered", !pageHtml().includes("/api/v1/artifacts") && !pageHtml().includes("/app/history") && !pageHtml().includes("inspect="));
  check("one file gets no ZIP button", !buttonLabels().some((label) => label.includes("ZIP")), buttonLabels().join(" | "));
}

/* ------------------------------------------------- 2. more files, and the ZIP */
section("two more files in the same queue: one ZIP of the copies held in the tab");
chooseFiles([imageFile(red, "red.png", "image/png"), imageFile(green, "green.png", "image/png")]);
await waitFor(() => findButton("Optimize 2 files") !== null);
press("Optimize 2 files");
const allNames = "green-optiweb.webp,photo-optiweb.webp,red-optiweb.webp";
await waitFor(() => [...downloads().keys()].sort().join(",") === allNames);
{
  const links = downloads();
  check("all three files have a download, and the first file kept its copy", [...links.keys()].sort().join(",") === allNames && allDownloadsAreTabCopies(), [...links.keys()].join(","));
  check("one \"Download all (ZIP)\" button is offered", buttonLabels().filter((label) => label.includes("ZIP")).join("|") === "Download all (ZIP)", buttonLabels().join(" | "));
  const sentBefore = requests.length;
  press("Download all (ZIP)");
  await waitFor(() => saved.length === 1);
  const archive = saved[0]?.blob ? await JSZip.loadAsync(Buffer.from(await saved[0].blob.arrayBuffer())).catch(() => null) : null;
  const entries = archive ? Object.keys(archive.files).sort() : [];
  check("the ZIP is saved as optiweb-images.zip and holds the three files", saved[0]?.name === "optiweb-images.zip" && entries.join(",") === allNames, `${saved[0]?.name}: ${entries.join(",")}`);
  let identical = entries.length === 3;
  for (const name of entries) {
    const inZip = Buffer.from(await archive.file(name).async("uint8array"));
    const behindLink = await fileBehind(links.get(name));
    identical &&= behindLink !== null && inZip.equals(behindLink) && (await sharp(inZip).metadata().then((image) => image.format === "webp", () => false));
  }
  check("each ZIP entry is byte-identical to the file behind its download link", identical);
  check("the ZIP is built in the tab: no request is sent for it", requests.length === sentBefore, requests.slice(sentBefore).join(", "));
  check("the confirmation says the files came from this tab", await waitFor(() => pageText().includes("3 optimized files downloaded from this tab.")));
}

/* ------------------------------------------------------ 3. releasing copies */
section("copies are released when they are no longer shown");
{
  const redUrl = downloads().get("red-optiweb.webp");
  const greenUrl = downloads().get("green-optiweb.webp");
  const heldBefore = held.size;
  check("removing a file from the queue removes its download", press("Remove red.png") && (await waitFor(() => !downloads().has("red-optiweb.webp"))) && downloads().size === 2, buttonLabels().join(" | "));
  check("the removed file's copy and preview are released; the others are kept", held.size === heldBefore - 2 && (await fileBehind(redUrl)) === null && (await fileBehind(greenUrl)) !== null, `${heldBefore} held before, ${held.size} after`);
  screen.unmount();
  await sleep(50);
  check("leaving the page releases every copy", held.size === 0 && (await fileBehind(greenUrl)) === null, `${held.size} still held`);
}

/* ---------------------------------------- 4. a site deployed without its API */
section("a site deployed without its API: the host answers /api with its own \"not found\" page");
host = `http://127.0.0.1:${hostWithoutApi.address().port}`;
screen = mount();
await waitFor(() => document.querySelector('input[type="file"]') !== null);
chooseFiles([imageFile(photo, "photo.jpg", "image/jpeg")]);
await waitFor(() => findButton("Optimize 1 file") !== null);
press("Optimize 1 file");
check("the batch is rejected with \"The API is not available on this site (HTTP 404).\"", await waitFor(() => pageText().includes("Batch rejected") && pageText().includes("The API is not available on this site (HTTP 404).")), pageText().slice(0, 300));
check("the explanation names the cause: a deployment without its server function", pageText().includes("without its server function") && pageText().includes("put the latest deployment into production") && !pageText().includes("non-JSON"));
check("the queue is unchanged and nothing is offered for download", findButton("Optimize 1 file") !== null && downloads().size === 0 && !pageText().includes("Converted"));
screen.unmount();
await sleep(50);
check("leaving the page releases the preview of the queued file", held.size === 0, `${held.size} still held`);

/* ------------------------------------------------------------------ summary */
section("the page");
// The API logs storage failures as JSON lines on the same channel. Anything
// else there was written by the page: a React error or warning.
const pageLog = api.takeLogs().lines.filter((line) => !line.startsWith("{"));
check("the page logged no error or warning", pageLog.length === 0 && pageErrors.length === 0, [...pageLog, ...pageErrors].join(" | ").slice(0, 300));

await vite.close();
await api.close();
hostWithoutApi.close();
const ok = report();
if (ok) console.log("\nAll Image Optimizer screen checks passed.");
process.exit(ok ? 0 : 1);
