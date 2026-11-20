/**
 * Finds and starts a real Chromium or Chrome for the browser tests.
 *
 * Search order:
 *   1. CHROME_PATH (or PUPPETEER_EXECUTABLE_PATH), when set;
 *   2. a Chrome or Chromium installed on this machine (GitHub's runners have one);
 *   3. the `@sparticuz/chromium` npm package, when it is installed. It carries its
 *      own Chromium build and is the way to get a browser where none can be
 *      installed: `npm install --no-save @sparticuz/chromium`.
 *
 * The tests need a real browser because what they prove (decoding, canvas
 * encoding, WebAssembly codecs, Web Workers, and the absence of network
 * requests) does not exist in a simulated DOM.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const SYSTEM_CANDIDATES = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

function onPath(names) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (directory && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function bundledChromium() {
  // Extra places to look for the package, for sandboxes that keep it outside the project.
  const roots = [import.meta.url, ...(process.env.UNIKIT_CHROMIUM_MODULES ?? "").split(delimiter).filter(Boolean).map((directory) => pathToFileURL(join(directory, "/")).href)];
  for (const root of roots) {
    try {
      const resolved = createRequire(root).resolve("@sparticuz/chromium");
      // The package unpacks the shared libraries it ships only when it believes it runs on AWS Lambda.
      process.env.AWS_EXECUTION_ENV ??= "AWS_Lambda_nodejs22.x";
      process.env.AWS_LAMBDA_JS_RUNTIME ??= "nodejs22.x";
      const chromium = (await import(pathToFileURL(resolved).href)).default;
      return { executablePath: await chromium.executablePath(), args: chromium.args, source: "@sparticuz/chromium" };
    } catch {
      /* not installed there */
    }
  }
  return null;
}

/** Where a browser was found, or null. */
export async function findBrowser() {
  const configured = process.env.CHROME_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configured) {
    if (!existsSync(configured)) throw new Error(`CHROME_PATH points to ${configured}, which does not exist.`);
    return { executablePath: configured, args: [], source: "CHROME_PATH" };
  }
  const system = SYSTEM_CANDIDATES.find((candidate) => existsSync(candidate)) ?? onPath(["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]);
  if (system) return { executablePath: system, args: [], source: "system" };
  return bundledChromium();
}

export const NO_BROWSER_HELP = [
  "No Chrome or Chromium was found.",
  "  - Set CHROME_PATH to a Chrome or Chromium executable, or",
  "  - install one, or",
  "  - run `npm install --no-save @sparticuz/chromium`, which brings its own Chromium.",
].join("\n");

/** Starts the browser. Throws with instructions when there is none. */
export async function launchBrowser(options = {}) {
  const found = await findBrowser();
  if (!found) throw new Error(NO_BROWSER_HELP);
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: found.executablePath,
    headless: found.source === "@sparticuz/chromium" ? "shell" : true,
    // The pages under test are this project's own, served from localhost. The
    // sandbox is off because CI containers and some Linux kernels do not allow it.
    args: [...found.args, "--no-sandbox", "--disable-dev-shm-usage", ...(options.args ?? [])],
    protocolTimeout: options.protocolTimeout ?? 180_000,
  });
  return { browser, source: found.source, executablePath: found.executablePath, version: await browser.version() };
}
