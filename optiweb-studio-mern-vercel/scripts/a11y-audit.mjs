/**
 * Static accessibility smoke check for the Vite/React application.
 * This does not replace axe or a browser-based accessibility audit.
 */
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
}

const html = await read("../index.html");
const css = await read("../src/styles.css");
const main = await read("../src/main.tsx");
const feedback = await read("../src/components/ui/Feedback.tsx");
const buttons = await read("../src/components/ui/Button.tsx");
const dropzone = await read("../src/components/ui/FileDropzone.tsx");
const form = await read("../src/components/ui/Form.tsx");
const theme = await read("../src/components/ui/ThemeToggle.tsx");
const features = await Promise.all([
  read("../src/features/images/ImageOptimizer.tsx"),
  read("../src/features/fonts/FontOptimizer.tsx"),
  read("../src/features/assets/AssetAnalyzer.tsx"),
  read("../src/features/audit/WebsiteAudit.tsx"),
]);

check("document language is defined", /<html[^>]*lang="en"/.test(html));
check("responsive viewport is defined", /name="viewport"/.test(html));
check("skip link is present", /href="#main"/.test(html));
check("React root is present", /id="root"/.test(html));
check("theme is applied before first paint", html.includes("ow-theme") && html.includes("prefers-color-scheme"));
check("keyboard focus styling exists", css.includes(":focus-visible") || css.includes("focus-visible"));
check("reduced-motion handling exists", css.includes("prefers-reduced-motion") || css.includes("ow-reduce-motion"));
check("theme control has accessible name", /aria-label=\{LABEL\[choice\]\}/.test(theme));
check("button components default to non-submit semantics", /type = "button"/.test(buttons) && /type=\{type\}/.test(buttons));
check("feedback supports live announcements", /role="status"|aria-live/.test(feedback));
check("application has a not-found route", main.includes("NotFoundPage") && /path="\*"/.test(main));
check("form fields have shared accessible label patterns", /htmlFor|aria-describedby/.test(form) && /aria-describedby/.test(dropzone));
const allFeatureText = features.join("\n");
check("meaningful image elements include alternative text", !/<img(?![^>]*\balt\s*=)/.test(allFeatureText));

for (const item of checks) console.log(`${item.ok ? "✓" : "✗"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} static accessibility checks passed.`);
if (failed.length) process.exit(1);
console.log("This is a static smoke-check only; run a browser/axe audit for full accessibility verification.");
