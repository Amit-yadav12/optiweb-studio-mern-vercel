# Deployment guide — MERN on Vercel

## Architecture

- Frontend: React + TypeScript + Vite, built to `dist/` and served by Vercel CDN.
- API: Express in `src/index.ts`, exposed through `api/[...path].ts` as a Vercel Node.js function.
- Data: MongoDB Atlas via Mongoose.
- Image processing: Sharp.
- CSS analysis: PostCSS.

Vercel serves the Vite `dist/` output as static assets and routes `/api/**` to the Express function. This avoids serving compiled JavaScript and CSS through Express. Vercel documents that `express.static()` does not serve static assets in the hosted Express function, so the frontend is deliberately deployed as the Vite static output. Reference: https://vercel.com/docs/frameworks/backend/express

## Before deploy

1. Push the project to GitHub or use the Vercel CLI.
2. Create a MongoDB Atlas database and user.
3. Configure Atlas network access according to your deployment's security requirements.
4. Set `MONGODB_URI` in the Vercel project's environment settings.
5. Optional: set `PAGESPEED_API_KEY` for PageSpeed Insights reports.
6. Keep Vercel's request/response budget in mind. The platform enforces a 4.5 MB request-body and function-response limit: https://vercel.com/docs/errors/function_payload_too_large

## Project configuration

`vercel.json` sets Vite as the framework, uses `dist/` as its static output directory, applies an SPA fallback rewrite, and configures `api/**/*.ts` with a 60-second maximum duration. The build command runs TypeScript checking before Vite builds the frontend. No PostgreSQL database or Drizzle migration is used.

## Environment variables

See `.env.example`. Important values:

- `MONGODB_URI`: required for durable history and artifact downloads.
- `OW_MAX_FILE_MB`: per-upload source limit; default 1 MB.
- `OW_MAX_BATCH_MB`: complete request budget; default 3.8 MB.
- `OW_MAX_FILES`: maximum number of source files per request; default 4.
- `OW_MAX_ARTIFACT_MB`: maximum size of an individual stored/downloadable output; default 3.5 MB.
- `OW_MAX_ZIP_MB`: maximum generated ZIP response size; default 3.5 MB.
- `OW_ARTIFACT_TTL_HOURS`: artifact retention; default 720 hours.
- `PAGESPEED_API_KEY`: optional PageSpeed Insights integration.

Do not expose server-side variables through `VITE_*` variables.

## Verification after deployment

1. Open `/api/health` and confirm the database state.
2. Open `/api/v1/limits` and confirm the enforced caps.
3. Upload a supported small image, optimize it, download the output, and verify the file opens.
4. Analyze CSS and download a patched stylesheet.
5. Refresh the browser and confirm the session-scoped history remains available.
6. Try a malformed file and verify a clear error is returned.
7. Test Light, Dark, and System themes on desktop and mobile.
8. Inspect browser console and network failures.

Do not consider the release production-ready until these checks pass on the actual deployed URL.

## Limits and scaling

Vercel Functions have request/response payload restrictions and do not provide durable local filesystem storage. Keep uploads and generated responses within configured budgets. For large assets, use direct object-storage uploads/downloads with authorized signed URLs and deploy a worker on a runtime suitable for longer processing. Rate limiting is currently process-local and should use a shared store if the application is scaled across multiple function instances.
