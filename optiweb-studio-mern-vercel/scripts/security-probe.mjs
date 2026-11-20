#!/usr/bin/env node
/**
 * Security and privacy probe. Reads the source, the configuration, the
 * dependency list and the build; starts no server.
 *
 *   npm run test:security
 *
 * The app's privacy claim is structural: files cannot be uploaded because
 * nothing exists that could upload or receive them. This probe checks that
 * structure, so that a later change which adds an upload path, a storage
 * dependency, a third-party host or a weaker header fails here:
 *
 *  1. Browser code: one place calls `fetch`, it sends JSON to this origin, and
 *     no other API that can send data is used anywhere.
 *  2. Server code: no body parser other than a small JSON one, no file
 *     writes, no cookies, and only the environment variables that are documented.
 *  3. Dependencies: no database driver, storage SDK, upload parser, session
 *     library or server-side image library, direct or transitive.
 *  4. Headers: the Content-Security-Policy and the other security headers are
 *     identical for the server, Vercel and Netlify.
 *  5. The build: no host name of a third party that the pages could talk to.
 *  6. The audit's address filter: what counts as a public address.
 *
 * What a browser actually sends is measured, not inferred, by
 * `npm run test:browser`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createChecker } from "./lib/selftest-kit.mjs";

const { check, section, report, crashed } = createChecker("security-probe");
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

const appDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = path.resolve(appDir, "..");
const read = (relative, base = appDir) => readFileSync(path.join(base, relative), "utf8");
const walk = (directory, keep) => {
  const found = [];
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (keep(full)) found.push(path.relative(appDir, full).split(path.sep).join("/"));
    }
  };
  if (existsSync(directory)) visit(directory);
  return found.sort();
};
/** The code of a file without its comments, so a word in a comment is not mistaken for a use. Strings and JSX text stay. */
const codeOf = (relative) => ts.transpileModule(read(relative), { compilerOptions: { removeComments: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;

const isServer = (file) => file.startsWith("src/server/") || file === "src/app.ts" || file === "src/index.ts";
const sources = walk(path.join(appDir, "src"), (file) => /\.(ts|tsx)$/.test(file));
const browserFiles = sources.filter((file) => !isServer(file));
const serverFiles = [...sources.filter(isServer), ...walk(path.join(appDir, "api"), (file) => file.endsWith(".ts")), ...walk(path.join(appDir, "netlify"), (file) => file.endsWith(".ts"))];
const browserCode = new Map(browserFiles.map((file) => [file, codeOf(file)]));
const serverCode = new Map(serverFiles.map((file) => [file, codeOf(file)]));
const usesOf = (code, pattern) => [...code].filter(([, text]) => pattern.test(text)).map(([file]) => file);

/* ------------------------------------------------------------ browser code */
section(`browser code (${browserFiles.length} files): nothing that could send a file`);
{
  const fetchers = usesOf(browserCode, /\bfetch\s*\(/);
  check("fetch is called in exactly one file, the API client", fetchers.join() === "src/lib/api-client.ts", fetchers.join(", "));
  const client = browserCode.get("src/lib/api-client.ts");
  const fetchCall = client.slice(client.search(/\bfetch\s*\(/), client.indexOf("});", client.search(/\bfetch\s*\(/)));
  check("that client sends a JSON string and nothing else as a body", /body:\s*init\.json === undefined \? undefined : JSON\.stringify\(init\.json\)/.test(fetchCall) && (fetchCall.match(/\bbody\s*:/g) ?? []).length === 1, fetchCall.replace(/\s+/g, " "));
  check("it sends no cookies or other credentials", /credentials:\s*"omit"/.test(client));
  const callers = [...browserCode].flatMap(([file, text]) => [...text.matchAll(/\bapi\.(get|postJson)\s*(?:<[^>]*>)?\(\s*(["'`])([^"'`]+)\2/g)].map((match) => `${file} → ${match[1]} ${match[3]}`));
  check("the client is used for one request: the audit, which posts a URL", callers.join() === "src/features/audit/WebsiteAudit.tsx → postJson /api/v1/audits", callers.join("; "));
  const forbidden = {
    FormData: /\bFormData\b/,
    XMLHttpRequest: /\bXMLHttpRequest\b/,
    "navigator.sendBeacon": /\bsendBeacon\b/,
    WebSocket: /\bWebSocket\b/,
    EventSource: /\bEventSource\b/,
    WebRTC: /\bRTC(PeerConnection|DataChannel)\b/,
    WebTransport: /\bWebTransport\b/,
    "service workers": /\bserviceWorker\b/,
    IndexedDB: /\bindexedDB\b/i,
    "the Cache API": /\bcaches\s*\./,
    "document.cookie": /document\s*\.\s*cookie/,
    "eval and new Function": /\beval\s*\(|new\s+Function\s*\(/,
    importScripts: /\bimportScripts\b/,
    "window.open": /window\s*\.\s*open\s*\(/,
    "dangerouslySetInnerHTML": /dangerouslySetInnerHTML|\.innerHTML\s*=/,
  };
  const found = Object.entries(forbidden).flatMap(([name, pattern]) => usesOf(browserCode, pattern).map((file) => `${name} in ${file}`));
  check(`none of these is used anywhere: ${Object.keys(forbidden).join(", ")}`, found.length === 0, found.join("; "));
  // Elements are looked for in the files that can contain markup. A plain .ts file can only mention one in a message.
  const markup = new Map([...browserCode].filter(([file]) => file.endsWith(".tsx")));
  const elements = usesOf(markup, /<(form|iframe|object|embed)[\s>]/);
  check("no page contains a <form>, <iframe>, <object> or <embed>: nothing can be submitted and nothing foreign is embedded", markup.size > 20 && elements.length === 0, elements.join(", "));
  const messaging = usesOf(browserCode, /\bpostMessage\s*\(/);
  check("postMessage is used only between the page and its own image worker", messaging.join() === "src/features/images/engine/engine.ts,src/features/images/engine/worker.ts", messaging.join(", "));
  const workers = [...browserCode].flatMap(([file, text]) => [...text.matchAll(/new\s+(Shared)?Worker\s*\(([^)]*)\)/g)].map((match) => `${file}: ${match[2].replace(/\s+/g, " ")}`));
  check("the only worker is that module, loaded from this site's own build", workers.length === 1 && workers[0].startsWith("src/features/images/engine/engine.ts") && /new URL\("\.\/worker\.ts", import\.meta\.url/.test(workers[0]), workers.join("; "));
  const local = usesOf(browserCode, /\blocalStorage\b/).filter((file) => !/SettingsForm/.test(file));
  const session = usesOf(browserCode, /\bsessionStorage\b/).filter((file) => !/SettingsForm/.test(file));
  check("localStorage holds settings and the theme only; sessionStorage holds the stylesheet draft only", local.join() === "src/components/ui/ThemeToggle.tsx,src/lib/preferences.ts" && session.join() === "src/features/fonts/FontOptimizer.tsx", `${local.join(",")} | ${session.join(",")}`);
  const literals = [...browserCode].flatMap(([file, text]) => [...text.matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)].map((match) => `${file}: ${match[0]}`));
  const unexpected = literals.filter((entry) => !/https:\/\/example\.com$|http:\/\/ns\.adobe\.com$|http:\/\/www\.w3\.org$/.test(entry));
  check("no address of another site appears in browser code, apart from a placeholder and XML namespaces", unexpected.length === 0, unexpected.join("; "));
  const html = read("index.html");
  const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  check("index.html has no inline script and loads nothing from another origin", !/<script(?![^>]*\bsrc=)[^>]*>/.test(html) && references.length >= 5 && references.every((reference) => /^(\/(?!\/)|#)/.test(reference)), references.filter((reference) => !/^(\/(?!\/)|#)/.test(reference)).join(" "));
  const theme = read("public/theme.js");
  check("the one script that runs before the app only reads the theme and the motion setting", !/fetch|XMLHttpRequest|sendBeacon|document\.cookie|import\(|src\s*=/.test(theme) && /unikit:theme/.test(theme));
}

/* ------------------------------------------------------------- server code */
section(`server code (${serverFiles.length} files): nothing that could receive or keep a file`);
{
  const forbidden = {
    "a raw, text or urlencoded body parser": /express\s*\.\s*(raw|text|urlencoded)\s*\(/,
    "a multipart parser": /\b(multer|busboy|formidable|multiparty|fileUpload)\b/i,
    "reading an incoming request's body by hand": /\breq\s*\.\s*(pipe|on|read|setEncoding)\s*\(|\breq\s*\.\s*rawBody\b/,
    "writing to the file system": /\b(writeFile|appendFile|createWriteStream|mkdir|mkdtemp|rename|copyFile|rm|unlink)(Sync)?\s*\(/,
    "the fs module": /from\s+"(node:)?fs(\/promises)?"/,
    "a child process": /child_process/,
    "setting a cookie": /\.cookie\s*\(|set-cookie/i,
    "a database or storage client": /\b(mongoose|mongodb|MongoClient|@vercel\/blob|S3Client|redis|prisma|sqlite|knex)\b/i,
  };
  const found = Object.entries(forbidden).flatMap(([name, pattern]) => usesOf(serverCode, pattern).map((file) => `${name} in ${file}`));
  check(`none of these is present: ${Object.keys(forbidden).join("; ")}`, found.length === 0, found.join("; "));
  const app = serverCode.get("src/app.ts");
  const parsers = [...app.matchAll(/express\s*\.\s*(json|raw|text|urlencoded)\s*\(/g)].map((match) => match[1]);
  check("the only body parser is one JSON parser, on the audit route, limited to 16 KB", parsers.join() === "json" && /express\.json\(\{\s*limit:\s*MAX_JSON_BODY_BYTES/.test(app) && /MAX_JSON_BODY_BYTES = 16 \* 1024/.test(serverCode.get("src/server/config/env.ts")));
  const routes = [...app.matchAll(/app\.(get|post|put|patch|delete)\(\s*(["'`/])([^"'`,)]*)/g)].map((match) => `${match[1].toUpperCase()} ${match[2] === "/" ? "(any path)" : match[3]}`);
  check("the routes are: two health checks, the audit, and the pages", routes.join("; ") === "GET /api/health; GET /api/v1/health; POST /api/v1/audits; GET (any path)", routes.join("; "));
  const imports = new Set([...serverCode.values()].flatMap((text) => [...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])).filter((name) => !name.startsWith(".") && !name.startsWith("@/")));
  const allowed = new Set(["express", "zod", "serverless-http", "dotenv/config", "node-html-parser", "node:path", "node:crypto", "node:dns/promises", "node:net", "node:http", "node:https"]);
  const extra = [...imports].filter((name) => !allowed.has(name));
  check("the server imports only its web framework, a validator, an HTML parser and Node's network modules", extra.length === 0, `not on the list: ${extra.join(", ")}`);
  const variables = new Set([...serverCode.values()].flatMap((text) => [...text.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1])));
  const settings = new Set([...serverCode.values()].flatMap((text) => [...text.matchAll(/setting\("([A-Z0-9_]+)"\)/g)].map((match) => match[1])));
  check("the server reads four environment variables by name: PAGESPEED_API_KEY, PORT, NODE_ENV, NETLIFY", [...variables].sort().join() === "NETLIFY,NODE_ENV,PAGESPEED_API_KEY,PORT", [...variables].sort().join());
  check("and eight optional audit limits, all prefixed AUDIT_", settings.size === 8 && [...settings].every((name) => name.startsWith("AUDIT_")), [...settings].join());
  const example = read(".env.example");
  const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]));
  const undocumented = [...variables].filter((name) => !["NODE_ENV", "NETLIFY"].includes(name) && !documented.has(name)).concat([...settings].filter((name) => !documented.has(`UNIKIT_${name}`)));
  check(".env.example documents every variable the server reads", undocumented.length === 0, undocumented.join(", "));
  const stale = [...documented].filter((name) => /MONGO|BLOB|CRON|STORAGE|SESSION|CLIENT_ORIGIN|VITE_API|SECRET|REQUEST_/.test(name));
  check(".env.example no longer lists a database, storage, cron or session variable", stale.length === 0, stale.join(", "));
}

/* ------------------------------------------------------------ dependencies */
section("dependencies: nothing that stores, uploads or decodes on a server");
{
  const manifest = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const installed = Object.keys(lock.packages ?? {}).filter(Boolean).map((key) => key.replace(/^.*node_modules\//, ""));
  const banned = /^(mongoose|mongodb|mongodb-.*|bson|mquery|kareem|mpath|sift|mingo|@vercel\/blob|@vercel\/functions|@vercel\/kv|@vercel\/postgres|@aws-sdk\/.*|aws-sdk|@google-cloud\/.*|@azure\/.*|firebase.*|@supabase\/.*|multer|busboy|formidable|multiparty|express-fileupload|sharp|@img\/.*|jimp|canvas|redis|ioredis|pg|mysql2?|sqlite3|better-sqlite3|prisma|@prisma\/.*|knex|sequelize|typeorm|cookie-parser|express-session|cookie-session|jsonwebtoken|passport.*|node-cron|bull|bullmq|nodemailer|@sentry\/.*|posthog.*|mixpanel.*|@segment\/.*)$/;
  const direct = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
  check("package.json names no database, storage, upload, session, analytics or server-side image package", direct.filter((name) => banned.test(name)).length === 0, direct.filter((name) => banned.test(name)).join(", "));
  check(`neither does anything in the lockfile (${installed.length} packages)`, installed.length > 100 && installed.filter((name) => banned.test(name)).length === 0, [...new Set(installed.filter((name) => banned.test(name)))].join(", "));
  check("the lockfile is for this package", lock.name === manifest.name && lock.packages[""].version === manifest.version && manifest.name === "unikit-studio");
  const runtime = Object.keys(manifest.dependencies ?? {}).sort();
  check("runtime dependencies are the ones the app uses, and no more", runtime.join() === "@fontsource-variable/inter,@fontsource/jetbrains-mono,@jsquash/avif,@jsquash/webp,dotenv,express,jszip,lucide-react,node-html-parser,postcss,react,react-dom,react-router-dom,serverless-http,zod", runtime.join());
  const scripts = Object.keys(manifest.scripts);
  check("no script refers to a file that does not exist", scripts.every((name) => [...manifest.scripts[name].matchAll(/scripts\/[\w./-]+\.mjs|src\/[\w./-]+\.ts/g)].every((match) => existsSync(path.join(appDir, match[0])))), scripts.filter((name) => ![...manifest.scripts[name].matchAll(/scripts\/[\w./-]+\.mjs|src\/[\w./-]+\.ts/g)].every((match) => existsSync(path.join(appDir, match[0])))).join(", "));
}

/* ----------------------------------------------------------------- headers */
section("headers and hosting configuration");
const { SECURITY_HEADERS, CONTENT_SECURITY_POLICY } = await import("../src/server/config/securityHeaders.ts");
{
  const directives = Object.fromEntries(CONTENT_SECURITY_POLICY.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values.join(" ")]));
  check("the policy's default is this origin only", directives["default-src"] === "'self'");
  check("pages may connect to this origin only: fetch, XHR, WebSocket, EventSource and beacons to anywhere else are blocked by the browser", directives["connect-src"] === "'self'");
  check("forms may be sent to this origin only", directives["form-action"] === "'self'");
  check("scripts and workers come from this origin; WebAssembly may be compiled, eval may not", directives["script-src"] === "'self' 'wasm-unsafe-eval'" && directives["worker-src"] === "'self'");
  check("images come from this origin or from this tab's memory (blob:, data:)", directives["img-src"] === "'self' blob: data:");
  check("fonts and the manifest come from this origin; plugins are off; the page cannot be framed", directives["font-src"] === "'self'" && directives["manifest-src"] === "'self'" && directives["object-src"] === "'none'" && directives["frame-ancestors"] === "'none'" && directives["base-uri"] === "'self'");
  check("no directive names another host, a wildcard or a scheme that reaches the network", !/https?:|\*|wss?:/.test(CONTENT_SECURITY_POLICY), CONTENT_SECURITY_POLICY);
  check("the other headers: no MIME sniffing, no framing, a short referrer, device features off", SECURITY_HEADERS["X-Content-Type-Options"] === "nosniff" && SECURITY_HEADERS["X-Frame-Options"] === "DENY" && SECURITY_HEADERS["Referrer-Policy"] === "strict-origin-when-cross-origin" && /camera=\(\), microphone=\(\), geolocation=\(\)/.test(SECURITY_HEADERS["Permissions-Policy"]));

  const vercel = JSON.parse(read("vercel.json"));
  const vercelAll = Object.fromEntries(vercel.headers.find((entry) => entry.source === "/(.*)").headers.map((header) => [header.key, header.value]));
  check("vercel.json sends exactly the same headers for every path", JSON.stringify(vercelAll) === JSON.stringify(SECURITY_HEADERS), JSON.stringify(vercelAll).slice(0, 200));
  const netlify = read("netlify.toml", repoDir);
  const block = netlify.split(/\[\[headers\]\]/).find((part) => /for\s*=\s*"\/\*"/.test(part)) ?? "";
  const netlifyAll = Object.fromEntries([...block.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/gm)].filter((match) => match[1] !== "for").map((match) => [match[1], match[2]]));
  check("netlify.toml sends exactly the same headers for every path", JSON.stringify(netlifyAll) === JSON.stringify(SECURITY_HEADERS), JSON.stringify(netlifyAll).slice(0, 200));
  const cache = "public, max-age=31536000, immutable";
  check("hashed build files are cached for a year on all three", vercel.headers.find((entry) => entry.source === "/assets/(.*)").headers[0].value === cache && new RegExp(`for\\s*=\\s*"/assets/\\*"[\\s\\S]*?Cache-Control\\s*=\\s*"${cache}"`).test(netlify) && read("src/app.ts").includes(cache));
  check("vercel.json schedules no job and declares one function, the API", vercel.crons === undefined && Object.keys(vercel.functions).join() === "api/index.ts" && walk(path.join(appDir, "api"), () => true).join() === "api/index.ts");
  check("netlify.toml schedules no job and has one function, the API", !/schedule\s*=|\[functions\."/.test(netlify) && walk(path.join(appDir, "netlify"), () => true).join() === "netlify/functions/api.ts");
  check("both hosts route /api to that function and every other path to the app", vercel.rewrites[0].source === "/api/(.*)" && vercel.rewrites[1].destination === "/index.html" && /from\s*=\s*"\/api\/\*"\s*\n\s*to\s*=\s*"\/\.netlify\/functions\/api\/:splat"/.test(netlify) && /from\s*=\s*"\/\*"\s*\n\s*to\s*=\s*"\/index\.html"/.test(netlify));
  check(
    "a build file that does not exist is a 404 on all three, never the app's page",
    vercel.rewrites[1].source === "/((?!api(?:/|$)|assets/).*)" &&
      netlify.indexOf('from = "/assets/*"\n  to = "/asset-not-found.txt"\n  status = 404') > 0 &&
      netlify.indexOf('from = "/assets/*"\n  to = "/asset-not-found.txt"') < netlify.indexOf('from = "/*"\n  to = "/index.html"') &&
      existsSync(path.join(appDir, "public", "asset-not-found.txt")) &&
      /app\.use\("\/assets", \(_req, res\) => \{[\s\S]{0,160}status\(404\)/.test(read("src/app.ts")),
  );
  const workflow = read(".github/workflows/ci.yml", repoDir);
  check("the CI workflow starts no database", !/mongo|services:/i.test(workflow), workflow.match(/.*mongo.*/i)?.[0] ?? "");
  check("the CI workflow uses no secret and can only read the repository", !/secrets\./.test(workflow) && /permissions:\n {2}contents: read\n/.test(workflow) && !/permissions:[\s\S]*?write/.test(workflow));
  const suites = Object.keys(JSON.parse(read("package.json")).scripts).filter((name) => name.startsWith("test:"));
  const runner = read("scripts/run-tests.mjs");
  const notInCi = suites.filter((name) => !workflow.includes(`run: npm run ${name}\n`));
  const notInRunner = suites.filter((name) => !runner.includes(`script: "${name}"`));
  check(`every test suite (${suites.length}) is run by CI and by \`npm test\``, suites.length === 10 && notInCi.length === 0 && notInRunner.length === 0, `not in CI: ${notInCi.join(", ") || "none"}; not in npm test: ${notInRunner.join(", ") || "none"}`);
  check("CI runs the browser suite in Chrome's headless shell, which sends nothing of its own", /@puppeteer\/browsers install chrome-headless-shell@stable/.test(workflow) && /CHROME_PATH: \$\{\{ steps\.browser\.outputs\.path \}\}\n {8}run: npm run test:browser\n/.test(workflow));
  check("CI also runs the smoke test against the started server, and against the deployed site on main", /node scripts\/deployed-smoke\.mjs http:\/\/127\.0\.0\.1:5000 --expect-build/.test(workflow) && /node scripts\/deployed-smoke\.mjs "\$url" --expect-build --wait 600/.test(workflow));
}

/* ------------------------------------------------------------------- build */
section("the build");
if (!existsSync(path.join(appDir, "dist", "index.html"))) {
  check("dist/ exists (run `npm run build` first)", false);
} else {
  const files = walk(path.join(appDir, "dist"), (file) => /\.(js|css|html|json|webmanifest|svg|txt)$/.test(file));
  const hosts = new Map();
  for (const file of files) {
    for (const match of read(file).matchAll(/\b(?:https?|wss?):\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) {
      hosts.set(match[1], [...(hosts.get(match[1]) ?? []), file]);
    }
  }
  // Text that names a site without the page ever contacting it: XML namespaces, links in error messages of libraries, a placeholder.
  const inert = new Set([
    "www.w3.org", "ns.adobe.com", // XML namespaces
    "example.com", // the placeholder in the audit's URL field
    "react.dev", "reactrouter.com", // links inside error messages of React and React Router
    "stuk.github.io", "stuartk.com", "raw.github.com", "github.com", // JSZip's licence banner and error messages
    "evilmartians.com", "www.w3ctech.com", // PostCSS's warning texts and comments
    "tailwindcss.com", // the banner comment of the stylesheet
  ]);
  const other = [...hosts.keys()].filter((host) => !inert.has(host));
  check(`host names in the build are namespaces, documentation links and a placeholder only (${[...hosts.keys()].sort().join(", ")})`, other.length === 0, other.map((host) => `${host} in ${[...new Set(hosts.get(host))].join(", ")}`).join("; "));
  const all = files.map((file) => read(file)).join("\n");
  check("no analytics, tag manager, font service or CDN is referenced", !/google-analytics|googletagmanager|gtag\(|fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg\.com|cdnjs|segment\.com|sentry\.io|hotjar|plausible|posthog/i.test(all));
  check("the build does not contain the previous product name", !/optiweb/i.test(all), files.filter((file) => /optiweb/i.test(read(file))).join(", "));
  const assets = readdirSync(path.join(appDir, "dist", "assets"));
  check("fonts are files of this site", assets.filter((name) => name.endsWith(".woff2")).length > 0 && !/url\((["']?)https?:/.test(files.filter((file) => file.endsWith(".css")).map((file) => read(file)).join("\n")));
  const html = read("dist/index.html");
  check("the built page has no inline script, and every script and stylesheet is same-origin", !/<script(?![^>]*\bsrc=)[^>]*>/.test(html) && [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)].every((match) => match[1].startsWith("/") && !match[1].startsWith("//")));
  const social = /property="og:image" content="([^"]+)"/.exec(html)?.[1] ?? "";
  check("the social image is this site's own file", /(^|\/)og-image\.png$/.test(social), social);
}

/* ------------------------------------------------------------ address filter */
section("website audit: what counts as a public address");
{
  const { assertPublicIp, parseHttpUrl, assertPublicHostname } = await import("../src/server/security/ssrf.ts");
  const refused = (address) => { try { assertPublicIp(address); return false; } catch { return true; } };
  const privateOnes = [
    "127.0.0.1", "127.255.255.254", "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.0", "100.127.255.255", "169.254.169.254", "172.16.0.0", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.168.0.1",
    "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.7", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:c0a8:1",
    "fc00::1", "fd12:3456:789a::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "2001:db8::1", "64:ff9b::7f00:1", "2002:7f00:1::1",
  ];
  const publicOnes = ["1.1.1.1", "8.8.8.8", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "169.253.255.255", "169.255.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "198.17.255.255", "198.20.0.0", "223.255.255.255", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "::ffff:808:808"];
  const let_through = privateOnes.filter((address) => !refused(address));
  check(`${privateOnes.length} loopback, private, link-local, metadata, multicast and documentation addresses are refused, however they are written`, let_through.length === 0, let_through.join(", "));
  const blocked = publicOnes.filter(refused);
  check(`${publicOnes.length} public addresses, including the ones next to each private range, are accepted`, blocked.length === 0, blocked.join(", "));
  check("anything that is not an IP address is refused, not waved through", ["", "localhost", "999.1.1.1", "1.2.3", "::g", "127.0.0.1:80", " 8.8.8.8"].every(refused));
  const parsed = (url) => { try { return parseHttpUrl(url).href; } catch { return null; } };
  check("only http and https URLs are parsed; other schemes and embedded credentials are refused", parsed("https://example.com/a?b=1") === "https://example.com/a?b=1" && parsed("  http://example.com ") === "http://example.com/" && ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "//example.com", "example.com", "", "https://user:pass@example.com/", "https://user@example.com/"].every((url) => parsed(url) === null));
  check("the URL parser turns every short or numeric way of writing 127.0.0.1 into 127.0.0.1, which is then refused", ["http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://0x7f.0.0.1/", "http://127.0.0.1./"].every((url) => refused(new URL(url).hostname.replace(/\.$/, ""))));
  const hostRefused = async (host) => assertPublicHostname(host).then(() => false, () => true);
  const names = ["localhost", "LOCALHOST", "localhost.", "app.localhost", "db.internal", "metadata.google.internal", "[::1]", "[::ffff:7f00:1]", "[fe80::1]", "127.0.0.1", "169.254.169.254"];
  const passed = [];
  for (const name of names) if (!(await hostRefused(name))) passed.push(name);
  check("host names that mean this machine or an internal network are refused without a DNS query", passed.length === 0, passed.join(", "));
}

const ok = report();
if (ok) console.log("\nAll security and privacy checks passed.");
process.exit(ok ? 0 : 1);
