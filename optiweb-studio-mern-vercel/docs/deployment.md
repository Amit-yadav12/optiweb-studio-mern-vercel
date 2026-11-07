# Netlify deployment guide

## Architecture and repository layout

This repository uses Netlify as its single deployment target. The Git checkout has the application in the nested `optiweb-studio-mern-vercel/` directory; the root `netlify.toml` configures that as the Base directory.

- Static frontend: React + Vite output in `dist/`.
- API: shared Express app in `src/app.ts`, adapted by `netlify/functions/api.ts` using `serverless-http`; `src/index.ts` is only the local/standalone listener.
- Database: MongoDB Atlas + Mongoose.
- Image runtime: Sharp + native libvips packages.
- CSS processing: PostCSS.

The rewrite from `/api/*` to `/.netlify/functions/api/:splat` is declared before the SPA fallback. The Netlify Express guide documents that this rewrite preserves the original API route for Express. Do not add a second `/api` prefix in the handler or a separate API implementation.

## Netlify settings

`netlify.toml` sets:

- Base: `optiweb-studio-mern-vercel`
- Build: `npm run build`
- Publish: `dist`
- Functions: `netlify/functions`
- Function bundler: esbuild
- External server modules: Express, Mongoose, Sharp
- `/api/*` function rewrite before the `/*` SPA fallback
- Static asset caching and baseline security headers

Keep this file authoritative. If a Netlify UI build setting overrides it, restore the nested base and paths rather than changing the application's route structure. `.nvmrc` pins the build/runtime major to Node 22.

## Environment variables

Required for real persistence:

- `MONGODB_URI`: server-only MongoDB Atlas URI, stored in Netlify's environment variable manager. It must never be prefixed with `VITE_`.

Optional:

- `PAGESPEED_API_KEY`: PageSpeed Insights measurements. Without a configured provider and returned data, the UI must not claim lab/field metrics.
- `CLIENT_ORIGIN`: comma-separated additional allowed browser origins. Leave empty for the same-origin site and API deployment.
- `OW_*`: documented limits in `.env.example`; adjust only after reviewing the Function runtime and all request/response overhead.

Use a restricted Atlas database user, rotate credentials if they were exposed, and configure Atlas network access to match the Netlify function's static egress or private connectivity. Do not use a permanent `0.0.0.0/0` Atlas allow rule. Verify region, plan support, and connectivity before testing writes.

## Netlify Function and resource limits

Current Netlify Function documentation lists a 60-second synchronous execution limit and 6 MB buffered request/response payload ceiling. Binary uploads are Base64 encoded, reducing the effective binary request budget to roughly 4.5 MB. This project uses still lower application budgets: 4.1 MB raw Express request body, 3.8 MB aggregate file bodies, 1 MB per file, 3.5 MB per artifact, and 3.5 MB per ZIP. The difference reserves room for multipart boundaries and envelopes. The generated artifact cap is enforced before persistence.

The function buffers multipart input and binary output through `serverless-http`; use the conservative limits for that transport. Large uploads require a separately authenticated object-storage transfer and worker design. They must not be implemented by raising limits blindly. Sharp decoded pixels, processing time, and concurrency are independently bounded.

Sharp is an external module in the function bundle so esbuild does not discard its native runtime packages. A local Linux Sharp test is useful but is not proof of the exact deployed Function package; inspect the Netlify build/function output and run conversion in the deployed preview.

## Preview-first release checklist

1. Connect the branch/repository and wait for a Deploy Preview build.
2. Check function discovery in the deploy output and review logs for initialization or native-module errors.
3. Request `/api/v1/health`; check `data.sharp.available` and `data.database.connected` separately.
4. Request `/api/v1/limits`; confirm AVIF is listed only after the real runtime encoder probe succeeds.
5. Upload one image and a two-image multipart batch. Verify output size/format from the API and download the stored artifact; decode it and compare its bytes/dimensions with the response.
6. Analyze and patch CSS, then compare the downloaded stylesheet with the displayed result.
7. Analyze image/CSS assets; verify measured metadata vs heuristic labels.
8. Run the Website Audit against a public test page; verify private URLs, redirects, and oversized responses are rejected and unavailable metrics are labelled unavailable.
9. Refresh History, verify session scope, delete a job, and verify its artifact is no longer accessible.
10. Verify the initial route, workspace routes, light/dark/system themes, desktop/mobile navigation, reduced-motion preference, browser console, and network requests.
11. Record cold and warm Function durations separately. Promote the preview only after the critical checks pass.

A local success does not verify Atlas connectivity or Netlify production settings. Do not mark production Ready until the preview and live environment pass the applicable checks.

## Local Netlify emulation

From the application directory, run:

```bash
npm ci
npm run build
npm run netlify:dev
```

The script changes to the repository root before invoking Netlify CLI so `netlify.toml` resolves its nested Base directory. Netlify CLI's local Functions tooling may need to download runtime components; environments without access to those downloads cannot complete `netlify dev`. In that case, `npm run test:function` still exercises the actual exported serverless handler using representative Netlify-style events, but does not replace a Deploy Preview.

## Local and persistence tests

- `npm run test:function`: no-database adapter smoke tests; deliberately refuses to run if a database URI is present.
- `npm test` / `npm run test:security`: run against a locally started API and an **isolated non-production test database**. These scripts create records and must never target production.
- `npm run test:a11y`: static source smoke checks only; supplement with browser testing and axe.

For a manual local API:

```bash
npm run dev
npm test -- http://127.0.0.1:5000
npm run test:security -- http://127.0.0.1:5000
```

## References

- Netlify Express integration: https://docs.netlify.com/build/frameworks/framework-setup-guides/express/
- Netlify Functions configuration and limits: https://docs.netlify.com/build/functions/configuration/
