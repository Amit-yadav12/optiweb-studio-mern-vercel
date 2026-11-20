/**
 * Renders the raster brand assets in `public/` from the vector mark.
 *
 *   node scripts/make-brand-assets.mjs
 *
 * The files it writes are committed, so this only needs to run when the mark,
 * the colours or the social card change. It draws them in a real browser, so
 * the text is set in the same fonts the app uses.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchBrowser } from "./lib/browser.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));
const ACCENT = "#365ce6";
const font = (file) => pathToFileURL(`${root}node_modules/${file}`).href;

const glyph = (colour = "#fff") =>
  `<path d="M9.5 8.2v8.3a6.5 6.5 0 0 0 13 0v-2.2" fill="none" stroke="${colour}" stroke-width="3.4" stroke-linecap="round"/><rect x="20.2" y="6.5" width="4.6" height="4.6" rx="1.1" fill="${colour}"/>`;
/** The mark as a rounded tile. */
const tile = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${ACCENT}"/>${glyph()}</svg>`;
/** The mark on a full square: iOS and maskable icons are cropped by the system, so the colour must reach the edge. */
const fullBleed = (size, scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" fill="${ACCENT}"/><g transform="translate(16 16) scale(${scale}) translate(-16 -16)">${glyph()}</g></svg>`;

const page = (body, width, height, background = "transparent") => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Inter Variable"; font-weight: 100 900; src: url("${font("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2")}") format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-weight: 500; src: url("${font("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2")}") format("woff2"); }
html, body { margin: 0; width: ${width}px; height: ${height}px; background: ${background}; overflow: hidden; }
svg { display: block; }
</style></head><body>${body}</body></html>`;

const socialCard = `
<div style="position:relative;width:1200px;height:630px;background:#0f1720;color:#fff;font-family:'Inter Variable',sans-serif;overflow:hidden">
  <div style="position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);background-size:48px 48px"></div>
  <div style="position:absolute;right:-140px;top:-140px;width:560px;height:560px;border-radius:50%;background:radial-gradient(circle,rgba(54,92,230,.55),rgba(54,92,230,0) 68%)"></div>
  <div style="position:absolute;left:80px;top:72px;display:flex;align-items:center;gap:20px">
    <svg width="64" height="64" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${ACCENT}"/>${glyph()}</svg>
    <div style="font-size:30px;letter-spacing:.08em"><span style="font-weight:650">UNIKIT</span> <span style="font-weight:400;color:#a9b8ca">STUDIO</span></div>
  </div>
  <div style="position:absolute;left:80px;top:218px;font-size:92px;line-height:1.04;font-weight:650;letter-spacing:-.035em">Lighter assets.<br>Nothing uploaded.</div>
  <div style="position:absolute;left:80px;top:446px;font-size:30px;line-height:1.35;color:#b8c5d6;max-width:900px">Image and web-asset tools that run in your browser.</div>
  <div style="position:absolute;left:80px;bottom:66px;display:flex;gap:12px;font-family:'JetBrains Mono',monospace;font-size:20px;font-weight:500;letter-spacing:.06em">
    ${["WEBP", "AVIF", "JPEG", "PNG", "CSS"].map((label) => `<span style="border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);padding:8px 14px;border-radius:4px;color:#dbe4ef">${label}</span>`).join("")}
  </div>
  <div style="position:absolute;right:80px;bottom:74px;font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:500;letter-spacing:.1em;color:#7f93aa">NO UPLOADS · NO COOKIES</div>
</div>`;

const assets = [
  { file: "icons/favicon-32.png", width: 32, height: 32, html: tile(32), transparent: true },
  { file: "icons/icon-192.png", width: 192, height: 192, html: tile(192), transparent: true },
  { file: "icons/icon-512.png", width: 512, height: 512, html: tile(512), transparent: true },
  { file: "icons/apple-touch-icon.png", width: 180, height: 180, html: fullBleed(180, 0.86), transparent: false },
  // A maskable icon keeps its content inside the central 80 %.
  { file: "icons/icon-maskable-512.png", width: 512, height: 512, html: fullBleed(512, 0.68), transparent: false },
  { file: "og-image.png", width: 1200, height: 630, html: socialCard, transparent: false },
];

mkdirSync(out("icons"), { recursive: true });
const { browser, version } = await launchBrowser({ args: ["--allow-file-access-from-files"] });
try {
  const tab = await browser.newPage();
  for (const asset of assets) {
    await tab.setViewport({ width: asset.width, height: asset.height, deviceScaleFactor: 1 });
    const source = `${root}scripts/.brand-asset.html`;
    writeFileSync(source, page(asset.html, asset.width, asset.height, asset.transparent ? "transparent" : ACCENT));
    await tab.goto(pathToFileURL(source).href, { waitUntil: "load" });
    await tab.evaluate(() => document.fonts.ready);
    await tab.screenshot({ path: out(asset.file), omitBackground: asset.transparent, type: "png", clip: { x: 0, y: 0, width: asset.width, height: asset.height } });
    console.log(`${asset.file.padEnd(32)} ${asset.width}×${asset.height}  ${readFileSync(out(asset.file)).length} bytes`);
  }
} finally {
  await browser.close();
  try {
    (await import("node:fs")).rmSync(`${root}scripts/.brand-asset.html`, { force: true });
  } catch {
    /* nothing to remove */
  }
}
console.log(`Rendered with ${version}.`);
