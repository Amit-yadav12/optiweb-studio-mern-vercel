# Release status — Netlify migration

## Current verdict: NOT READY FOR PRODUCTION

The Netlify architecture and local API workflows are implemented and materially verified, but production readiness is blocked by configuration: no safe Atlas URI or isolated test database is available, and no Netlify Deploy Preview or live production Function was deployed. Do not promote this branch until those blockers are cleared.

## Implemented

- Added root `netlify.toml` for the nested Base directory, Vite build, publish directory, Functions, esbuild bundling, `/api/*` rewrite, SPA fallback, caching, and security headers.
- Added `netlify/functions/api.ts` using the official Express + `serverless-http` adapter and the shared Express application in `src/app.ts`. The `src/index.ts` file is now only the standalone/local listener; importing the Function no longer starts a second listener.
- Removed the Vercel-only `vercel.json` and API catch-all so the repository has one documented deployment target.
- Added safe request correlation, JSON 503 errors for missing MongoDB during history reads, useful non-JSON frontend errors, and output-size checks.
- Upgraded vulnerable production packages (Sharp, Zod, React Router); production dependency audit reports zero vulnerabilities.
- Added locally bundled Inter Variable and JetBrains Mono fonts, actual AVIF runtime probing, and honest PNG quality treatment.
- Fixed pre-existing TypeScript build errors and ESLint errors found in the baseline.
- Added a Netlify-style function self-test and updated deployment/API documentation.

## Verified checks

- `npm ci`: passed; lockfile installed successfully.
- `npm run build`: passed; `npm run typecheck`: passed.
- `npm run lint`: passed with four React Fast Refresh warnings and no lint errors.
- `npm run test:a11y`: 13/13 static accessibility smoke checks passed. This is not browser/axe testing.
- `npm run test:function`: 17/17 checks passed using the actual exported Function adapter and Netlify-style events. Covers API path and function-mount normalization, request IDs, HTTP-only cookie serialization, Sharp, AVIF, PostCSS analysis/patch, measured Asset Analyzer metadata, loopback SSRF rejection, explicit MongoDB 503, Base64 multipart, two real WebP conversions, and safe malformed-input JSON errors.
- `npx netlify-cli@27.16.2 build --offline` from the repository root: passed. Netlify discovered and bundled `api.ts`; the bundle contains Sharp plus Linux x64 Sharp/libvips native runtime packages.
- `netlify functions:serve` locally served the packaged Function. Health returned HTTP 200 with Sharp available; two-image WebP multipart optimization and CSS analysis completed through the actual Function server.
- Local function emulator health latency observed once at about 252 ms for the first request and 7 ms for the immediate warm request. These are local emulator timings with no MongoDB, not production/cold-start SLO measurements.
- Vite + local Express dev servers started. Home and `/app/images` returned HTTP 200; the `/api/v1/health` proxy worked; a real two-image WebP batch returned two completed results.
- `npm audit --omit=dev --audit-level=moderate`: zero production dependency vulnerabilities. Full audit still reports 12 moderate issues in development lint/tooling dependencies; no high/critical findings were reported.
- `git diff --check`: passed.

## Blocked / not verified

- `MONGODB_URI` and `MONGO_URL` are absent in this workspace. No actual Atlas connection, ping, writes, reads, artifact download, preferences persistence, history deletion/expiry, or cross-session isolation was tested. The image tests explicitly reported `persisted: false`; downloads are unavailable until MongoDB is configured.
- The conversation included Atlas credentials. Treat them as compromised and rotate the database secret/user before configuring a replacement `MONGODB_URI` in Netlify's server-side secret manager. No credential was copied into repository files or tests.
- No Netlify account/site credential or Deploy Preview was available. Function deployment, deployed native packaging, production URL, and deployed API behavior remain unverified.
- `netlify dev` reached local server startup but its Edge Functions setup attempted a runtime download blocked in this sandbox. `netlify build` and `netlify functions:serve` did succeed; the Deploy Preview is still required.
- No browser executable or visual inspection tool was available. Desktop/tablet/mobile rendering, both themes, interactive behavior, console, and axe audit are not claimed as visually verified. `DESIGN.md` was absent from the checkout; existing styles and the user-provided measured token brief were used.
- The full persistence API/security suites require a dedicated isolated database and were not run. Remote Website Audit was not tested against a public target; only the safe loopback SSRF rejection path was.
- The repository evidence confirms the old deployment configuration was Vercel-only and lacked Netlify Functions/routing. Without the old live Function logs or an original failing request trace, the exact exception behind the reported HTTP 500 cannot be proven retrospectively.

## Remaining release steps

1. Rotate the exposed Atlas secret; configure its replacement only in Netlify's server environment and set an Atlas network rule compatible with the chosen Function region/egress.
2. Deploy a Deploy Preview from this branch and verify the real database connection and session-scoped job/artifact/preferences workflows using a dedicated test session/database.
3. Verify actual image downloads and byte integrity, history CRUD/TTL/ownership, all primary routes, and Sharp runtime on the preview.
4. Run the API security/integration suite against an isolated non-production database.
5. Inspect real desktop/tablet/mobile screens in light and dark themes and record production cold/warm timings.
6. Promote only after these preview checks pass.
