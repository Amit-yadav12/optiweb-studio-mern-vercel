# Release status — OptiWeb Studio MERN + Vercel

## Included in this release

- React + TypeScript + Vite frontend with existing OptiWeb Studio tools and Light/Dark/System themes.
- Node.js + Express API adapted for local use and Vercel's `/api/**` function routing.
- MongoDB Atlas + Mongoose persistence for session-scoped history and generated artifacts.
- Bounded image processing, CSS font-display analysis/patching, uploaded-asset analysis, website resource audit, and history.
- Vercel-safe request, artifact, and ZIP-size defaults with documented constraints.
- Updated README, deployment guide, `.env.example`, static accessibility smoke check, and API test scripts.

## Checks completed in this environment

- TypeScript/TSX parser syntax scan: 58 files, zero syntax errors.
- Local import resolution scan: zero unresolved local imports.
- `package.json`, `tsconfig.json`, and `vercel.json`: valid JSON.
- Static accessibility smoke check: 13/13 checks passed.
- Node syntax checks for the API self-test and security probe scripts: passed.
- ZIP integrity must be checked after packaging.

## Checks not verified

- Full dependency installation did not complete because the package registry was unreachable from this environment.
- Production build, ESLint, TypeScript semantic type-check, running API integration tests, live MongoDB operations, browser-based visual checks, and a real Vercel deployment were therefore not verified.
- No production URL or deployment credentials were provided.

Do not interpret source-level checks as proof of a successful production build. Before release, run `npm install`, `npm run build`, `npm run lint`, and the relevant runtime tests in an environment with network access and a configured MongoDB Atlas database.

## Required setup

1. Create/configure a MongoDB Atlas database and set `MONGODB_URI` in the deployment environment.
2. Set optional `PAGESPEED_API_KEY` if PageSpeed Insights data is desired.
3. Extract the archive, install dependencies, and verify the build locally.
4. Commit the project to GitHub or deploy it using the Vercel CLI from the project root. Vercel's dashboard does not deploy a source ZIP as a ready-made application.
5. Test `/api/health`, image upload/optimization/download, CSS patch/download, history behavior, and both themes on the deployed URL.

## Known product boundaries

- The website auditor checks initial HTML and discoverable resources; it is not a complete headless-browser crawl.
- History is scoped to the browser's opaque guest session, not to user accounts or cross-device identity.
- Artifacts expire according to `OW_ARTIFACT_TTL_HOURS` and are not unlimited.
- Rate limits are process-local and would need shared storage for stronger enforcement across scaled instances.
- Vercel Function request and response limits require the documented conservative file-size settings; use object storage for larger assets.
