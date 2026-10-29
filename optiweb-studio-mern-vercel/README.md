# OptiWeb Studio

**Make every byte count.** OptiWeb Studio is a developer workspace for optimizing images, analyzing CSS font-loading rules, inspecting static assets, and auditing publicly reachable pages.

## Features

- **Image Optimizer:** Re-encodes supported raster images using Sharp, evaluates the chosen optimization policy, and reports actual input/output sizes, output format, dimensions, and measured savings. Supports bounded batch processing and ZIP export.
- **Font Optimizer:** Parses CSS using PostCSS, reports applicable `@font-face` declarations, safely applies a selected `font-display` policy, shows changes, and downloads the output.
- **Asset Analyzer:** Inspects uploaded images and CSS and produces evidence-based findings. Heuristics are labelled as heuristics.
- **Website Audit:** Fetches a public page's initial HTML and inspects discoverable resources. PageSpeed Insights lab/field data is attached only when configured and returned by the provider. This is not a full browser-rendered crawl.
- **History:** Session-scoped job metadata and generated artifacts are stored in MongoDB when configured. Artifacts default to a 30-day TTL; configure `OW_ARTIFACT_TTL_HOURS` to change it.
- **Settings and themes:** Session preferences plus Light, Dark, and System appearance.

Savings are computed from actual byte buffers. A smaller asset does not guarantee better LCP, INP, or CLS. Website performance depends on how resources are discovered, prioritized, rendered, and used.

## Technology stack

- React + TypeScript + Vite
- Node.js + Express.js
- MongoDB Atlas + Mongoose
- Sharp for raster image processing
- PostCSS for CSS parsing/transformation
- React Router for client-side navigation
- Tailwind CSS v4 for styling

The Express app lives at `src/index.ts`; `api/[...path].ts` exposes it as a catch-all Vercel API function. Vite builds the frontend into `dist/`, which Vercel serves as static assets from its CDN. This keeps frontend assets separate from API processing. The project does not use Next.js, Drizzle, or PostgreSQL.

## Local development

Requirements: Node.js 20.9+ and npm.

```bash
npm install
cp .env.example .env
# Set MONGODB_URI in .env for persistent history and artifact downloads.
npm run dev
```

This starts Vite on `http://localhost:5173` and Express on `http://localhost:5000`. Vite proxies `/api` to Express for local development.

To run a production-style local build:

```bash
npm run build
npm start
```

Open `http://localhost:5000` after building.

## Required configuration

`MONGODB_URI` is required for durable history and stored download artifacts. Create a MongoDB Atlas cluster and a database user, configure network access for your deployment, and add the connection string as an environment variable. Never commit the actual URI.

See `.env.example` for all supported limits and optional integrations.

### Vercel upload and download limits

Vercel Functions have a 4.5 MB request-body and response-body ceiling. This project uses conservative defaults (1 MB per source file, 3.8 MB total request budget, 3.5 MB per-artifact and ZIP output budget) to reduce the risk of platform-level 413 errors. Generated output can still be larger than the source, so use realistic test files and preserve the configured output limits. For larger workloads, use direct-to-object-storage transfers and a compatible processing worker rather than raising these limits blindly.

## Deployment to Vercel

The repository contains `vercel.json` configured for Vite. Vercel runs `npm run build` and serves `dist/` as static frontend assets. Requests under `/api/**` reach the Express catch-all in `api/[...path].ts`, which imports `src/index.ts`. Client-side routes fall back to `index.html`.

1. Extract this source archive into a normal project folder. Vercel deploys source through a Git provider or the Vercel CLI; the dashboard does not treat this ZIP as a ready-made application deployment. Official guides: https://vercel.com/docs/git and https://vercel.com/docs/projects/deploy-from-cli.
2. Create a GitHub repository, commit the extracted project, and import that repository in Vercel. Alternatively, install the Vercel CLI, run `vercel login`, then run `vercel` from this project's root directory. The generated `package-lock.json` should be committed after `npm install` succeeds locally.
3. Set `MONGODB_URI` in Vercel Project Settings → Environment Variables for Preview and Production as appropriate. The app can render without it, but persistent history and artifact downloads require a working MongoDB connection.
4. Keep the upload/ZIP settings within Vercel's request/response limits. Do not place `MONGODB_URI` or other server secrets in a `VITE_*` variable.
5. Deploy and inspect `/api/health`. The `database.connected` field must be `true` for persistent history and artifact retrieval to be considered ready.
6. Test an image upload, result download, CSS patch/download, history refresh, deletion, and mobile UI on the deployed URL.

Optional `PAGESPEED_API_KEY` adds PageSpeed Insights reports to the website-audit workflow. Without it, lab and field metrics from that provider are not available and must not be represented as measured.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run Vite and Express concurrently |
| `npm run build` | Type-check the project and build production assets |
| `npm run start` | Serve built frontend and APIs through Express |
| `npm run typecheck` | TypeScript checks |
| `npm run lint` | ESLint |
| `npm test` | API integration self-test; run the app and configure MongoDB first |
| `npm run test:security` | API security probes against a running app |
| `npm run test:a11y` | Static accessibility smoke-check; supplement with a browser/axe audit |

## Security notes

- Uploaded content is decoded/parsed; filename and declared MIME type are not trusted as proof of file type.
- Upload counts, sizes, image decoded pixels, CSS lengths, concurrency, and processing time are bounded by server configuration.
- Guest sessions use an opaque HTTP-only cookie and scope history/artifacts to that session.
- Remote URL auditing is an SSRF-sensitive feature. Keep the audit limits conservative and review the deployment's egress controls before exposing it publicly.
- Output artifacts are private to the issuing session and expire by configured TTL.
- The API reports safe error messages; do not log uploaded file contents or credentials.

## Known boundaries

- History is guest-session scoped; the MVP does not provide user accounts or cross-device history.
- Artifact retention is configurable, not unlimited. MongoDB storage and Vercel function payloads are finite.
- Website audit inspects initial HTML and discoverable resources; it is not a full headless-browser crawl. PageSpeed Insights can add independently sourced measurements when configured.
- Positive compression savings cannot be guaranteed for every file. If a candidate is larger, the application reports the measured outcome instead of hiding it.
- Rate-limit buckets are process-local. A horizontally scaled deployment should use a shared rate-limit store.
