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
3. Request `/api/v1/health`; check `data.sharp.available` and `data.database.ready` separately. If `ready` is false, `data.database.category` names the cause (see "Storage diagnostics").
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

## Storage diagnostics

`GET /api/v1/health` always answers HTTP 200. Readiness is in the body: `data.ok` is true only when `data.database.ready` is true.

| Field of `data.database` | Meaning |
| --- | --- |
| `configured` | `MONGODB_URI` is set. |
| `connected` | The server accepted the connection and the credentials, and answered a ping. |
| `ready` | Connected, and the server accepted a read and a write command on the job collection. The write is a delete that matches nothing, so the check changes no data. |
| `latencyMs` | Duration of the whole check, when it succeeded. |
| `category`, `error`, `hint` | Present when `ready` is false: the failure category and its fixed wording. |

Every storage failure is reduced to one category. The browser and the log receive only the category and fixed wording, never the connection string or the driver's error message.

| Category | Cause |
| --- | --- |
| `not_configured` | `MONGODB_URI` is not set. |
| `invalid_uri` | The value is not a MongoDB connection string. |
| `dns_failure` | The host name does not resolve. An unencoded `@ : / ? #` in the password also ends up here. |
| `authentication_failed` | The server rejected the user name or password. |
| `network_access_denied` | The server accepted the TCP connection and dropped it, as an Atlas IP access list does. |
| `connection_refused` | Nothing listens at the address. |
| `server_selection_timeout` | No server answered within `OW_MONGO_TIMEOUT_MS` (default 5000). |
| `connection_failed` | Any other connection failure, including a TLS certificate problem. |
| `connection_lost` | The connection dropped during an operation. |
| `permission_denied` | The database user lacks the role for the operation. |
| `write_failed` | The database rejected the job record. |
| `artifact_insert_failed` | The database rejected an output file after the job record was written. |
| `read_failed` | A query failed on a working connection. |

Each failure writes one JSON line to the function log:

```json
{"level":"error","event":"storage_failure","category":"artifact_insert_failed","operation":"job.persist:image.optimize","stage":"artifact_insert","requestId":"…","errorName":"MongoBulkWriteError","errorCode":"121","errorCodeName":null,"causes":[],"detail":"document_validation_failed","rollback":"completed","durationMs":41,"timestamp":"…"}
```

`requestId` equals the `X-Request-Id` response header and `meta.requestId` in the response body, so a report from a user can be matched to its log line. Search the logs for `storage_failure`, or for the request ID.

A job is stored completely or not at all. If the job record or any output file is rejected, the job record and every file already written are deleted, and the response reports `persisted: false` with an empty `jobId` and `artifactId: null` for every result. `rollback` in the log line is `not_needed`, `completed` or `failed`. A failed rollback writes a second line with the event `storage_rollback_failed` and the `jobId` of the record that may be left behind.

## Local and persistence tests

- `npm run test:storage`: no database needed. Makes the connection and the database fail in each way listed above and checks the category, the log line, the request ID and the rollback. It also checks that no response or log line contains the connection string or an error message. Rejections that need a server reply come from a scripted stand-in that stores nothing, so this test does not show that persistence works.
- `npm run test:storage:mongo`: needs a real MongoDB server. Checks stored bytes, downloads, rollback and rejected credentials against the database itself. It changes collection validators and drops its database, so it refuses to run unless the database name starts with `optiweb_ci_` or `optiweb_test_`. CI runs it against a throwaway container.
- `npm run test:ui`: no browser needed. Renders the image results panel for each outcome and checks that downloads and History links appear only for stored output.
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
