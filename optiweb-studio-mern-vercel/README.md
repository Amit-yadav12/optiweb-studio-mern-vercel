# OptiWeb Studio

**Make every byte count.** A focused developer workspace for image optimization, CSS font-loading analysis, asset inspection, and safe document-level website audits.

## Product capabilities

- **Image Optimizer:** Sharp decodes uploads and produces bounded WebP, AVIF (only when the runtime encoder probe succeeds), JPEG, PNG, or source-format outputs. Input/output bytes, dimensions, processing time, and any negative savings are reported from real buffers. Animated sources are not silently flattened. Batches are concurrency-limited and constrained by actual request/artifact budgets.
- **Font Optimizer:** PostCSS parses `@font-face` declarations, reports malformed rules and missing `font-display`, applies `auto`, `block`, `swap`, `fallback`, or `optional`, and offers the exact resulting stylesheet for copy/download.
- **Asset Analyzer:** Reports measured image format, dimensions, and size, plus clearly labelled heuristic recommendations. CSS is routed through the font analysis workflow. It does not infer a file's rendered dimensions on a website.
- **Website Performance Audit:** Fetches a public document and a bounded set of discovered resources with SSRF checks, redirects revalidated, response caps, and time budgets. PageSpeed lab/field metrics appear only when the provider returns them. This is not a browser-rendered crawl.
- **History and Settings:** Mongoose persists session-owned jobs, binary artifacts, and preferences in MongoDB Atlas. History is not durable when the database is not configured; the UI labels that state and disables artifact downloads rather than pretending they work.
- **Appearance:** Light, Dark, and System themes with a pre-paint theme bootstrap, persistent choice, and reduced-motion support.

A smaller image is not proof of improved LCP, INP, or CLS. Savings shown by the optimizer are measured byte differences; website-level performance depends on resource discovery, priority, rendering, and usage.

## Architecture

- Frontend: React 19, TypeScript, Vite, React Router, Tailwind CSS v4; Inter and JetBrains Mono are locally bundled.
- Backend: one Express 5 application in `src/app.ts`, shared by the local `src/index.ts` launcher and Netlify Functions.
- Netlify adapter: `netlify/functions/api.ts` uses the documented `serverless-http` Express adapter. Netlify rewrites `/api/*` to this single function; the original `/api/...` path is retained for the existing Express routes.
- Database: MongoDB Atlas through Mongoose. The shared connection promise and warm-instance connection cache live in `src/server/db/mongo.ts`.
- Image and CSS processing: Sharp with libvips; PostCSS.

The prior Vercel-only entry point and `vercel.json` were removed so the repository has one documented deployment target: Netlify.

## Local development

Requirements: Node.js 22 (see `.nvmrc`) and npm.

```bash
cd optiweb-studio-mern-vercel
npm ci
cp .env.example .env
# Set MONGODB_URI in .env only if you have a dedicated, authorized development database.
npm run dev
```

Vite serves `http://localhost:5173` and proxies same-origin `/api` requests to Express at `http://localhost:5000`. You can run the Netlify CLI proxy from this package directory with `npm run netlify:dev`; the command starts from the repository root so the checked-in nested `base` setting is interpreted correctly. The CLI requires its normal local runtime downloads/network access.

## MongoDB Atlas configuration

Set `MONGODB_URI` as a **server-side** environment variable in Netlify Site configuration (and in a local `.env` only for a trusted development database). Never use `VITE_MONGODB_URI`, paste credentials into source, or commit `.env` files. The URI should select the intended database, for example `/optiweb?retryWrites=true&w=majority`.

Configure Atlas with a restricted database user and an IP/network policy that matches the Netlify function's configured static egress or private connectivity. Do not leave `0.0.0.0/0` as a permanent access rule. Confirm that your Netlify plan, function region, and Atlas network policy can reach one another before calling persistence verified.

Collections are `optiweb_jobs`, `optiweb_artifacts`, and `optiweb_preferences`. Artifact documents use a TTL index. Guest data is scoped to an opaque HTTP-only `ow_sid` cookie; this is session history, not an account system. Image artifacts are deliberately bounded for Function and MongoDB document limits. Larger files need a separately designed object-storage/worker path.

Health: `/api/v1/health` returns MongoDB connection state and measured probe latency without revealing the URI. A `200` response alone does not mean persistence is ready; check `data.database.connected`.

## Netlify deployment

The repository root contains `netlify.toml`; the application lives in `optiweb-studio-mern-vercel/`. The config sets the Base directory, build command, publish directory, functions directory, esbuild bundler, and the API rewrite ahead of the SPA fallback.

1. Connect this GitHub repository to Netlify and use the checked-in settings. Do not set a second conflicting base/publish directory in the UI.
2. Add `MONGODB_URI` in the Netlify environment variable panel for the Deploy Preview and Production contexts where persistence is intended. Add `PAGESPEED_API_KEY` only if PageSpeed Insights is desired.
3. Build and deploy a Deploy Preview first. Verify `/`, `/api/v1/health`, the function logs, MongoDB connection state, image upload/processing, stored artifact download, CSS patch/download, history refresh/deletion, and mobile/theme states.
4. Promote only after the preview workflows pass. Production promotion is intentionally not automated by this repository.

Netlify's current default buffered Function limit is 6 MB, while binary requests are Base64 encoded and effectively limited to about 4.5 MB; synchronous execution is limited to 60 seconds. This API buffers request/response bodies, so its tighter defaults are 1 MB/file, 3.8 MB total multipart content, 3.5 MB/artifact and 3.5 MB/ZIP. Multipart framing also consumes request budget. Do not increase these caps without testing the actual plan, binary overhead, response path, and Sharp memory/time budget. The Netlify Function externalizes Express, Mongoose, and Sharp so their runtime packages/native libvips dependency are included as server modules.

See [`docs/deployment.md`](docs/deployment.md) for the release checklist and [`docs/api.md`](docs/api.md) for route contracts.

## Verification commands

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run test:a11y
npm run test:function
```

`test:function` exercises the real `serverless-http` handler with synthetic Netlify-style events, including the API path, cookies, JSON, Base64 multipart uploads, Sharp conversion, and safe errors. It intentionally refuses to run when `MONGODB_URI` or `MONGO_URL` is present and explicitly verifies the no-database state; it does **not** test Atlas persistence.

`npm test` and `npm run test:security` target a running API and require a separate isolated test database because they create/delete test records. Never point those scripts at production. Browser-based visual/axe testing and live Netlify deployment checks must still be performed in an environment with a browser, Netlify account, and configured test database.

## Security and operational boundaries

- Upload sizes, file counts, decoded pixel count, transform concurrency, artifact bytes, ZIP bytes, and CSS size are bounded server-side.
- Upload content is decoded/sniffed by Sharp rather than trusted from the filename or declared MIME type.
- Remote audit requests reject private/reserved destinations, pin validated DNS results, re-check redirect destinations, cap body sizes, and use timeouts.
- Session identifiers are HTTP-only, `SameSite=Lax`, and `Secure` in production. Jobs and artifacts are queried by both id and session.
- Internal exception messages and request payloads are not written to server logs. `X-Request-Id` is available as a safe support reference.
- Rate limiting is process-local. A horizontally scaled production service should use a shared limiter if stronger global quotas are required.

## Known limitations

- Guest history is browser-session scoped and does not sync across devices.
- Binary artifacts are stored in MongoDB only within the current conservative limits; no object-storage backend exists.
- The Website Audit inspects initial HTML and discovered resources, not browser-rendered JavaScript or a full site crawl.
- Atlas persistence, account-specific egress/network access, Netlify Deploy Preview, and production status depend on hosting configuration and are not implied by a successful local build.
- `DESIGN.md` was not present in the checkout when work began. The existing `src/styles.css`, `docs/design-tokens.md`, and the user-provided measured light-theme tokens were used as the available design references; the attached visual capture could not be checked here.
