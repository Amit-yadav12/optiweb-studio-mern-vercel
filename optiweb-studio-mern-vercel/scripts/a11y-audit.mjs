#!/usr/bin/env node
/**
 * Accessibility checks. Needs no browser.
 *
 *   npm run test:a11y
 *
 * Three parts:
 *  1. The document shell (`index.html`): language, viewport, skip link.
 *  2. Colour: the contrast ratio of every text and background pair of the
 *     design tokens, in the light and the dark theme, computed with the WCAG
 *     formula from the values in `src/styles.css`.
 *  3. Every page, rendered: the real app is mounted in jsdom at each route and
 *     its DOM is inspected for headings, landmarks, names of controls, labels
 *     of fields, text alternatives, and references that resolve.
 *
 * jsdom does not lay out or paint. Focus order on screen, zoom and reflow,
 * and what a screen reader actually announces still need a person with a
 * browser; this covers the structure those depend on.
 */
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createDom, createModuleLoader } from "./lib/dom-kit.mjs";
import { createChecker } from "./lib/selftest-kit.mjs";

const { check, section, report, crashed } = createChecker("a11y-audit");
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

const read = (file) => readFile(new URL(file, import.meta.url), "utf8");

/* ------------------------------------------------------------------- shell */
section("the document");
const html = await read("../index.html");
{
  check("the language is declared", /<html[^>]*\blang="en"/.test(html));
  const viewport = /<meta name="viewport" content="([^"]+)"/.exec(html)?.[1] ?? "";
  check("the viewport allows zooming", /width=device-width/.test(viewport) && !/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(viewport), viewport);
  check("the page has a title that names the product and what it does", /<title>Unikit Studio — [^<]{20,}<\/title>/.test(html));
  const body = html.slice(html.indexOf("<body"));
  check("the first thing in the page is a link that skips to the main content", /^<body[^>]*>\s*<a href="#main"[^>]*>Skip to main content<\/a>/.test(body));
  check("that link is hidden until it has keyboard focus, then visible", /class="sr-only focus:not-sr-only/.test(body));
  check("without JavaScript the page says what it needs, instead of staying blank", /<noscript>[\s\S]*JavaScript[\s\S]*<\/noscript>/.test(html));
  check("both colour schemes are declared, so native controls follow the theme", /<meta name="color-scheme" content="light dark"/.test(html));
  const theme = await read("../public/theme.js");
  check("the theme is set before the first paint, from the stored choice or the system setting", /<script src="\/theme\.js"><\/script>/.test(html) && theme.includes("prefers-color-scheme") && theme.includes("unikit:theme") && theme.includes("data-theme"));
  check("the stored motion preference is applied before the first paint too", theme.includes("uk-reduce-motion") && theme.includes("reduceMotion"));
}

/* ------------------------------------------------------------------ colour */
section("colour contrast (WCAG 2.1, computed from the tokens)");
const css = await read("../src/styles.css");
{
  const tokens = (block) => Object.fromEntries([...block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((match) => [match[1], match[2]]));
  const light = tokens(/@theme\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "");
  const dark = { ...light, ...tokens(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "") };
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  check("both themes define the same tokens", Object.keys(light).length >= 25 && Object.keys(light).every((name) => name in dark), `${Object.keys(light).length} tokens`);
  // Text on background, as the components use them. 4.5:1 is the AA minimum for text of normal size.
  const TEXT = [
    ["ink", "canvas"], ["ink", "surface"], ["ink", "surface-sunken"],
    ["ink-soft", "canvas"], ["ink-soft", "surface"], ["ink-soft", "surface-sunken"],
    ["muted", "canvas"], ["muted", "surface"], ["muted", "surface-sunken"],
    ["accent", "canvas"], ["accent", "surface"], ["accent-hover", "accent-soft"],
    ["on-accent", "accent"], ["on-accent", "accent-hover"],
    ["ok", "surface"], ["ok", "ok-soft"], ["warn", "surface"], ["warn", "warn-soft"], ["danger", "surface"], ["danger", "danger-soft"],
  ];
  for (const [name, theme] of [["light", light], ["dark", dark]]) {
    const measured = TEXT.map(([text, background]) => ({ pair: `${text} on ${background}`, value: ratio(theme[text], theme[background]) }));
    const low = measured.filter((entry) => entry.value < 4.5);
    const worst = measured.reduce((a, b) => (a.value < b.value ? a : b));
    check(`${name} theme: all ${TEXT.length} text pairs reach 4.5:1 (lowest: ${worst.pair}, ${worst.value.toFixed(2)}:1)`, low.length === 0, low.map((entry) => `${entry.pair} ${entry.value.toFixed(2)}:1`).join("; "));
    // The focus ring and the borders of controls are graphics: 3:1.
    const ring = [["accent", "canvas"], ["accent", "surface"], ["accent", "surface-sunken"]].map(([a, b]) => ratio(theme[a], theme[b]));
    check(`${name} theme: the focus ring reaches 3:1 on every surface (lowest ${Math.min(...ring).toFixed(2)}:1)`, ring.every((value) => value >= 3));
  }
  check("white text is used on the accent colour only through the on-accent token", !/bg-accent(?![-\w])[^"`]*text-white|text-white[^"`]*bg-accent(?![-\w])/.test(await read("../src/components/ui/Button.tsx")));
  check("keyboard focus is always visible: a 2px outline in the accent colour", /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-accent\)/.test(css) && !/outline:\s*(none|0)\b/.test(css.replace(/focus:not\(:focus-visible\)[^}]*\}/g, "")));
  check("animation is switched off for people who ask the system for less motion, and by the app's own setting", /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration: 0\.001ms !important/.test(css) && /\.uk-reduce-motion \*[\s\S]*?transition-duration: 0\.001ms !important/.test(css));
}

/* ------------------------------------------------------------------- pages */
const dom = createDom("http://localhost/");
const { window, document, waitFor } = dom;
window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
window.scrollTo = () => {};
for (const name of ["PopStateEvent", "HTMLButtonElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLLabelElement"]) Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true });
const loader = await createModuleLoader();
const { mountApp } = await loader.load("/scripts/lib/mount-app.tsx");
mountApp(document.getElementById("root"));

/** The text of a node as it is read: a line break counts as a space. */
function visibleText(node) {
  if (!node || typeof node.cloneNode !== "function") return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const copy = node.cloneNode(true);
  for (const lineBreak of copy.querySelectorAll?.("br") ?? []) lineBreak.replaceWith(" ");
  return copy.textContent.replace(/\s+/g, " ").trim();
}
/** The accessible name of an element, by the rules that matter here: aria-labelledby, aria-label, a label element, then its text, alt text of images inside it, or its title. */
function nameOf(element) {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => visibleText(document.getElementById(id) ?? { textContent: "" })).join(" ").trim();
    if (text) return text;
  }
  const label = element.getAttribute("aria-label");
  if (label?.trim()) return label.trim();
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(element.tagName)) {
    const id = element.getAttribute("id");
    const forLabel = id ? document.querySelector(`label[for="${id}"]`) : null;
    const wrapping = element.closest("label");
    return visibleText(forLabel ?? wrapping ?? { textContent: "" }) || (element.getAttribute("title") ?? "").trim();
  }
  const text = visibleText(element);
  if (text) return text;
  const image = element.querySelector("img[alt], svg[aria-label]");
  return (image?.getAttribute("alt") ?? image?.getAttribute("aria-label") ?? element.getAttribute("title") ?? "").trim();
}
const describe = (element) => `<${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${element.className && typeof element.className === "string" ? `.${element.className.split(/\s+/)[0]}` : ""}>`;

/** Every problem found in the current page's DOM, in words. */
function problems() {
  const found = [];
  const all = (selector) => Array.from(document.querySelectorAll(selector));
  const headings = all("h1, h2, h3, h4, h5, h6");
  const levels = headings.map((heading) => Number(heading.tagName[1]));
  if (levels.filter((level) => level === 1).length !== 1) found.push(`${levels.filter((level) => level === 1).length} h1 elements`);
  if (levels[0] !== 1) found.push(`the first heading is h${levels[0]}`);
  levels.forEach((level, index) => {
    if (index > 0 && level > levels[index - 1] + 1) found.push(`heading level jumps from h${levels[index - 1]} to h${level} ("${visibleText(headings[index]).slice(0, 40)}")`);
  });
  for (const heading of headings) if (!visibleText(heading)) found.push("an empty heading");
  if (all("main").length !== 1) found.push(`${all("main").length} main landmarks`);
  if (document.getElementById("main")?.tagName !== "MAIN") found.push("the skip link's target #main is not the main landmark");
  const navs = all("nav");
  if (navs.length > 1 && navs.some((nav) => !nameOf(nav))) found.push("several nav landmarks, not all of them named");
  for (const control of all('button, a[href], [role="button"], [role="radio"], [role="tab"], [role="switch"], [role="checkbox"], summary')) {
    if (!nameOf(control)) found.push(`${describe(control)} has no accessible name`);
  }
  for (const field of all("input:not([type=hidden]), select, textarea")) {
    if (!nameOf(field)) found.push(`${describe(field)} has no label`);
  }
  for (const image of all("img")) if (!image.hasAttribute("alt")) found.push(`${describe(image)} has no alt attribute`);
  for (const graphic of all("svg")) {
    const hidden = graphic.getAttribute("aria-hidden") === "true" || graphic.closest('[aria-hidden="true"]') !== null;
    const named = graphic.getAttribute("role") === "img" && Boolean(nameOf(graphic) || graphic.querySelector("title"));
    if (!hidden && !named) found.push(`an svg that is neither hidden from assistive technology nor named (in ${describe(graphic.parentElement)})`);
  }
  const ids = all("[id]").map((element) => element.id);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length > 0) found.push(`duplicate ids: ${duplicates.join(", ")}`);
  for (const attribute of ["aria-labelledby", "aria-describedby", "aria-controls", "for"]) {
    for (const element of all(`[${attribute}]`)) {
      for (const id of element.getAttribute(attribute).split(/\s+/).filter(Boolean)) {
        if (!document.getElementById(id)) found.push(`${describe(element)} ${attribute}="${id}" points at nothing`);
      }
    }
  }
  for (const element of all("[tabindex]")) if (Number(element.getAttribute("tabindex")) > 0) found.push(`${describe(element)} has a positive tabindex`);
  for (const group of all('[role="radiogroup"]')) {
    const radios = Array.from(group.querySelectorAll('[role="radio"]'));
    if (!nameOf(group)) found.push("a radio group without a name");
    if (radios.filter((radio) => radio.getAttribute("aria-checked") === "true").length !== 1) found.push(`radio group "${nameOf(group)}" does not have exactly one checked option`);
    if (radios.some((radio) => !radio.hasAttribute("aria-checked"))) found.push(`radio group "${nameOf(group)}" has options without aria-checked`);
  }
  for (const element of all('[role="button"]')) if (!element.hasAttribute("tabindex")) found.push(`${describe(element)} acts as a button but cannot take keyboard focus`);
  for (const link of all("a[href]")) {
    const href = link.getAttribute("href");
    if (/^https?:/.test(href) && link.getAttribute("target") === "_blank" && !/noopener/.test(link.getAttribute("rel") ?? "")) found.push(`external link ${href} opens a new tab without rel=noopener`);
    if (href === "#" || href === "") found.push(`${describe(link)} is a link that goes nowhere`);
  }
  for (const table of all("table")) if (table.querySelectorAll("th").length === 0) found.push("a table without header cells");
  // The faint colour is below 4.5:1 by design. It is for icons and rules, never for words.
  for (const element of all('[class~="text-faint"]')) {
    if (Array.from(element.childNodes).some((node) => node.nodeType === 3 && node.textContent.trim() !== "")) found.push(`${describe(element)} shows text ("${visibleText(element).slice(0, 30)}") in the faint colour, which is for decoration only`);
  }
  for (const element of all("[aria-hidden='true']")) if (element.querySelector('button, a[href], input, select, textarea, [tabindex="0"]')) found.push(`${describe(element)} is hidden from assistive technology but contains a focusable control`);
  return found;
}

const PAGES = [
  ["/", "Lighter assets. Nothing uploaded."],
  ["/app", "Your files stay on this device."],
  ["/app/images", "Image Optimizer"],
  ["/app/fonts", "Font Optimizer"],
  ["/app/assets", "Asset Analyzer"],
  ["/app/audit", "Website Performance Audit"],
  ["/app/settings", "Settings"],
  ["/app/history", "History"],
  ["/app/usage", "Storage"],
  ["/404", "This page does not exist"],
];
section(`every page, rendered (${PAGES.length} routes)`);
const titles = new Set();
/** What the browser tab shows for each route. */
const tabTitles = new Map();
let previous = null;
let previousText = "";
for (const [route, heading] of PAGES) {
  if (route !== "/") {
    window.history.pushState({}, "", route);
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  }
  // The page is ready when the router has replaced the previous page's heading and nothing is still loading.
  const changed = () => document.querySelector("h1") !== previous || visibleText(document.querySelector("h1")) !== previousText;
  const ready = await waitFor(() => document.querySelector("h1") !== null && changed() && document.querySelector("main") !== null && !/Loading…/.test(document.body.textContent), 20_000);
  await sleep(30);
  previous = document.querySelector("h1");
  const h1 = visibleText(previous);
  previousText = h1;
  titles.add(h1);
  tabTitles.set(route, document.title);
  const found = ready ? problems() : ["the page did not render"];
  check(`${route} — "${h1}"`, found.length === 0 && (heading === null || h1 === heading), [heading !== null && h1 !== heading ? `the heading should be "${heading}"` : null, ...found].filter(Boolean).slice(0, 8).join("; "));
}
check("each page has its own main heading", titles.size === PAGES.length, [...titles].join(" | "));
// A page reached from another page must not keep that page's title in the tab.
check("each page has its own title in the browser tab, with the product's name in it", new Set(tabTitles.values()).size === PAGES.length && [...tabTitles.values()].every((title) => title.includes("Unikit Studio")), [...tabTitles].map(([route, title]) => `${route}: ${title}`).join(" | "));
{
  window.history.pushState({}, "", "/app/images");
  window.dispatchEvent(new window.PopStateEvent("popstate"));
  await waitFor(() => /Image Optimizer/.test(document.querySelector("h1")?.textContent ?? ""));
  const current = Array.from(document.querySelectorAll('nav a[aria-current="page"]')).map(visibleText);
  check("the navigation marks the current page", current.length === 1 && current[0] === "Image Optimizer", current.join(", "));
  check("messages that appear later are announced: the page has a live region", document.querySelector('[aria-live], [role="status"], [role="alert"]') !== null);
  const dropzone = document.querySelector('[role="button"][aria-describedby]');
  check("the file dropzone can be reached and used with the keyboard, and its limits are read out with it", dropzone?.getAttribute("tabindex") === "0" && visibleText(document.getElementById(dropzone.getAttribute("aria-describedby"))).length > 20);
  const slider = document.querySelector("#quality");
  check("the quality slider has a label, a range and a spoken value", slider?.getAttribute("type") === "range" && nameOf(slider).startsWith("Quality") && slider.getAttribute("min") === "30" && slider.getAttribute("max") === "100" && /of 100/.test(slider.getAttribute("aria-valuetext") ?? ""));
  check("no page needed the network to render", dom.network.length === 0, JSON.stringify(dom.network));
  check("no page raised a script error", dom.pageErrors.length === 0, dom.pageErrors.join(" | "));
}

await loader.close();
const ok = report();
if (ok) console.log("\nAll accessibility checks passed. They cover structure and colour; keyboard order on screen and screen-reader output still need a person with a browser.");
process.exit(ok ? 0 : 1);
