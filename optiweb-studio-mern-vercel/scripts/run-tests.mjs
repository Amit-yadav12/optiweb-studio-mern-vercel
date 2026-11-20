#!/usr/bin/env node
/**
 * Runs every self-test, one after another, and prints one summary.
 *
 *   npm test                 every suite; the browser suite if a browser is found
 *   npm test -- --browser    fail when no browser is found, instead of skipping
 *   npm test -- --no-browser leave the browser suite out
 *   npm test -- unit api     only the named suites
 *
 * A suite that fails does not stop the others, so one run reports everything.
 * The exit code is 0 only when every suite that ran passed and none that was
 * required was skipped.
 *
 * Suites that read the build (`api`, `security`, `browser`) need
 * `npm run build` first. This script builds when `dist/` is missing.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser } from "./lib/browser.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
process.chdir(appDir);

const SUITES = [
  { name: "unit", script: "test:unit", what: "header parser, pre-decode check, planner, CSS and asset analysis, settings" },
  { name: "pipeline", script: "test:pipeline", what: "image pipeline steps and engine scheduling" },
  { name: "ui", script: "test:ui", what: "result model: sizes, savings, kept originals, totals" },
  { name: "dom", script: "test:dom", what: "Image Optimizer screen in a DOM" },
  { name: "audit", script: "test:audit", what: "website audit against a made-up site" },
  { name: "api", script: "test:api", what: "HTTP contract of the server", needsBuild: true },
  { name: "security", script: "test:security", what: "source, dependencies, headers and build", needsBuild: true },
  { name: "function", script: "test:function", what: "Netlify function adapter" },
  { name: "a11y", script: "test:a11y", what: "accessibility of every page, rendered" },
  { name: "browser", script: "test:browser", what: "real browser: files never leave the tab", needsBuild: true, needsBrowser: true },
];

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const named = args.filter((arg) => !arg.startsWith("--"));
const unknown = named.filter((name) => !SUITES.some((suite) => suite.name === name));
if (unknown.length > 0 || [...flags].some((flag) => !["--browser", "--no-browser"].includes(flag))) {
  console.error(`Unknown argument: ${[...unknown, ...[...flags].filter((flag) => !["--browser", "--no-browser"].includes(flag))].join(", ")}`);
  console.error(`Suites: ${SUITES.map((suite) => suite.name).join(", ")}. Flags: --browser, --no-browser.`);
  process.exit(2);
}
const selected = SUITES.filter((suite) => (named.length === 0 || named.includes(suite.name)) && !(flags.has("--no-browser") && suite.needsBrowser));
const requireBrowser = flags.has("--browser") || named.includes("browser") || process.env.CI === "true";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (script) => spawnSync(npm, ["run", "--silent", script], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

if (selected.some((suite) => suite.needsBuild) && !existsSync(path.join(appDir, "dist", "index.html"))) {
  console.log("dist/ is missing: building first.\n");
  const build = spawnSync(npm, ["run", "build"], { stdio: "inherit" });
  if (build.status !== 0) {
    console.error("\nThe build failed, so the suites that need it cannot run.");
    process.exit(1);
  }
}

const browser = selected.some((suite) => suite.needsBrowser) ? await findBrowser() : null;
const results = [];
for (const suite of selected) {
  if (suite.needsBrowser && !browser) {
    results.push({ suite, status: requireBrowser ? "missing" : "skipped", detail: "no Chrome or Chromium found (set CHROME_PATH)", ms: 0 });
    continue;
  }
  console.log(`\n━━━ ${suite.name}: ${suite.what} ━━━`);
  const started = Date.now();
  const outcome = run(suite.script);
  const output = outcome.stdout ?? "";
  // The whole output of a failing suite is shown; of a passing one, only its last lines.
  const lines = output.trimEnd().split("\n");
  console.log(outcome.status === 0 ? lines.slice(-4).join("\n") : output.trimEnd());
  const counts = /(\d+) passed, (\d+) failed/.exec(output) ?? /(\d+)\/(\d+) .*checks passed/.exec(output);
  results.push({ suite, status: outcome.status === 0 ? "passed" : "failed", detail: counts ? counts[0] : outcome.error ? String(outcome.error.message) : `exit code ${outcome.status}`, ms: Date.now() - started });
}

console.log("\n━━━ summary ━━━");
const mark = { passed: "✓", failed: "✗", skipped: "–", missing: "✗" };
for (const { suite, status, detail, ms } of results) {
  console.log(`  ${mark[status]} ${suite.name.padEnd(9)} ${status.padEnd(8)} ${detail}${ms ? `  (${(ms / 1000).toFixed(1)} s)` : ""}`);
}
const failed = results.filter((result) => result.status === "failed" || result.status === "missing");
const skipped = results.filter((result) => result.status === "skipped");
if (skipped.length > 0) {
  console.log(`\nNot run: ${skipped.map((result) => result.suite.name).join(", ")}. The browser suite is the one that measures what a browser sends; install Chrome or set CHROME_PATH, then run \`npm run test:browser\`.`);
}
console.log(failed.length === 0 ? `\n${results.length - skipped.length} of ${results.length} suites ran, all passed.` : `\n${failed.length} suite${failed.length === 1 ? "" : "s"} failed: ${failed.map((result) => result.suite.name).join(", ")}.`);
process.exit(failed.length === 0 ? 0 : 1);
