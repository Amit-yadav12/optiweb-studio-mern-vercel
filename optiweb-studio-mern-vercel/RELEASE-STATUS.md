# Release status — high-capacity uploads

Date: 2026-11-18. Branch: `arena/f22e6b19-optiweb-studio-mern-vercel`.

## Verdict: NOT READY

The high-capacity mode is implemented and tested everywhere except where it finally has to work. Nothing in it has run on Vercel: not the Vercel Blob calls, not the worker inside a function, not a streamed download through a function. The release gate in the brief is a verified Vercel preview, and that gate is not met.

Three things stand in the way, and none of them is in the repository:

1. **The production address does not serve the current code.** `optiweb-studio-mern-vercel.vercel.app` still answers every `/api` path with Vercel's 404 page, as it has since 2026-11-10. A deployment of `main` has to be promoted in the Vercel dashboard.
2. **No object storage is known to be connected.** Direct uploads need a private Vercel Blob store with a read-write token.
3. **The database refuses the hosts.** The Netlify sites, which do run the current code, report `network_access_denied` from MongoDB Atlas. The same is likely on Vercel.

Preview deployments of this branch build successfully on Vercel, but they are behind Vercel's login, so they could not be exercised from outside. The Vercel connector has no access to the team's projects, so settings, environment variables and logs could not be read.

Merging this branch is safe in the meantime: without object storage the application behaves as before, with the same small limits, and says which mode is in effect.

## What to do, in order

1. In Vercel, promote the newest deployment of `main` to production (or use "Undo Rollback").
2. In Atlas, allow the hosts in Network Access. Rotate the database password that was pasted into the chat, and put the new connection string, with a database name, in `MONGODB_URI`.
3. In Vercel: Storage → Create → Blob → **Private**, with "Add a read-write token env var to this connection" ticked.
4. Add `CRON_SECRET` (at least 16 letters and digits). Redeploy.
5. Open `/api/v1/limits`: `image.mode` must read `direct`.
6. Run the workflow "CI" on `main`. Its job "Production serves this build and converts an image" then uploads a 6.6 MB file straight to the Blob store, follows the background job and downloads a 6.2 MB result. That run is the first real test of everything listed as unverified below.

## 1. Limits before

Files travelled inside the request to a function, which Vercel caps at 4.5 MB: 1 MB per file, 4 files and 3.8 MB per batch, 24 MP per image. Results were kept in MongoDB documents, 3.5 MB at most, and a ZIP was buffered, 3.5 MB at most. Conversion ran inside the request. The rate limit lived in the memory of one function instance. There was no storage quota. Settings and the landing page showed limits the server did not enforce (10 MB, 8 files, 400,000 characters).

## 2. Architecture now

```
browser ── create job ────────────────▶ API ── job, files, quota ──▶ MongoDB
browser ── ask for upload authorization ▶ API   (20 minutes, one path, one size, one type)
browser ══ file ═════════════════════════════════════════════════▶ Vercel Blob (private)
browser ── confirm ───────────────────▶ API ── looks the file up in storage; checks size and signature
                                         API ── worker: read, convert, write result ──▶ Vercel Blob
browser ── poll / download ───────────▶ API ── streams the result to the session that owns it
```

- MongoDB is the record of everything. The Blob store holds only bytes, and nothing in it is public.
- A job is a record with a state and a lease. A worker claims it with one conditional write, processes one file at a time, and extends the lease while it works. If the function dies, the next run takes the job over.
- The standard upload inside the request is unchanged and is used when object storage or the database is missing.

## 3. Files changed

64 files, about 8,000 lines added. New server code is in `src/server/storage/` (object storage interface, Vercel Blob driver, local driver) and `src/server/pipeline/` (jobs, worker, quotas, cleanup, streamed ZIP). New frontend code: `src/features/images/directJob.ts` and `directUpload.ts`, `src/features/usage/StorageUsage.tsx`, `src/lib/limits.ts`. Changed: the Image Optimizer, Asset Analyzer, Website Audit, Settings, landing page, History, the limits and artifact routes, `auditService.ts`, `imageService.ts`, `vercel.json`, CI, docs.

## 4. New dependencies

| Package | Why |
| --- | --- |
| `@vercel/blob` 2.9 | Object storage: client tokens, private reads, writes, deletes. Also loaded in the browser, on first use, for the upload itself (28 kB gzipped, in its own chunk). |
| `@vercel/functions` 3.11 | `waitUntil`, so the worker can run after the response. |
| `mingo` 7.2 (dev only) | Query engine of the in-memory database stand-in used by tests on machines without MongoDB. |

No paid service was activated. Vercel Blob is billed by Vercel according to the plan; that cost starts when a store is created and used.

## 5. MongoDB

New collections, created on first use with their indexes:

| Collection | Holds |
| --- | --- |
| `optiweb_uploads` | One record per source file of a background job: its upload, its processing state, its result. |
| `optiweb_usage` | Byte counters per session and for the whole application. |
| `optiweb_usage_days` | Application-wide counters per day (uploads, conversions, conversion time, downloads, failures, retries). Kept 90 days. |
| `optiweb_rate_limits` | Rate-limit windows. Expire on their own. |
| `optiweb_job_slots` | One document per job in progress; the unique `_id` is what limits jobs per session. |

Changed, without a migration:

- `optiweb_jobs`: background jobs carry `mode: "async"`, a state, a lease and `expireAt`. Records of the synchronous tools now get `expireAt` too (180 days). Records written before this release have no `expireAt` and are kept as before.
- `optiweb_artifacts`: files of background jobs are records with `storage: "object"` and a storage path instead of the bytes. Existing records are untouched.

## 6. Blob storage

A **private** store, addressed through `BLOB_READ_WRITE_TOKEN`. Paths are generated by the server (`src/<owner>/<job>/<upload>/<name>`, `out/<owner>/<job>/<item>/<name>`), where `<owner>` is a one-way key derived from the session, never the session ID. Every object is written with a storage-side expiry as a backstop behind the cleanup routine. **Not connected or tested**: see the verdict.

## 7. Background processing

MongoDB job records with leases, driven by `waitUntil` after the confirming request, by status reads, and by a daily scheduled call (`vercel.json`).

Vercel Workflows and Queues were evaluated and not used. Workflows documents Express support only through a Nitro build, which would replace this project's build and could not be verified. Queues is in beta. With the present design a job is never lost, but on the Hobby plan an interrupted job that nobody looks at resumes only with the daily schedule; on Pro the schedule can run every minute.

## 8. Limits now

| | Direct uploads | Inside a request (fallback) |
| --- | --- | --- |
| File | 25 MB | 1 MB |
| Files per job | 10 | 4 |
| Job in total | 150 MB | 3.8 MB |
| Decoded pixels per image / per job | 40 MP / 160 MP | 24 MP / – |
| Generated file | 50 MB | 3.5 MB |
| ZIP download | 250 MB, streamed | 3.5 MB |
| AVIF output | 16 MP | 24 MP |
| CSS input | 1 MB | 1 MB |
| Asset analysis | 10 files, 3.8 MB in total | same |
| Website audit | 3 pages, 25 resources per page, 1 MB per document and resource, 24 MB and 45 s in total | same |
| Storage per session | 500 MB | – |
| Jobs in progress per session | 2 | – |

Retention: sources 24 hours after the job, generated files 30 days, job records 180 days. Advanced capacity (50 MB, 20 files, 500 MB, 50 MP) is not available; the flag is read and reported, and raises nothing.

## 9–13. Tests

All of the following pass in CI on the last commit of this branch. "MongoDB" means a real `mongo:7` server in the CI job.

| Suite | Checks | What it covers |
| --- | --- | --- |
| `test:pipeline`, MongoDB | 161 | The pipeline through the HTTP API on the local storage driver: every limit at admission, upload authorization (one file, size, type, session, expiry, forged or altered signatures), confirmation (size mismatch, not an image, duplicate and simultaneous confirmations), formats, transparency, animation, pixel limits, partial failure, retries, storage failures, missing objects, concurrent workers, recovery after a crash, cancellation, quotas under simultaneous requests, idempotency, shared rate limit, ownership, retention, cleanup, History. |
| `test:pipeline`, in-memory stand-in | 156 | The same without MongoDB; checks the logic, not the queries. |
| `test:dom:direct`, both databases | 19 each | The Image Optimizer screen in jsdom: upload with progress, job, downloads, ZIP link, cancel, failed uploads, batch limits. |
| Smoke test against a server process with MongoDB and object storage on disk | 17 | A 6.6 MB direct upload, a background job run by the server itself, a 6.2 MB streamed download. |
| `test:audit` | 23 | Page and resource limits of the audit, against a made-up site. |
| Earlier suites (API with MongoDB 107, persistence 54, storage diagnostics 226, results panel 102, optimizer screen 24, Netlify adapter 19, accessibility 13) | 545 | Unchanged behaviour of the request path. |

The MongoDB run earned its place: it found that three simultaneous jobs could all be admitted where two were allowed, which the stand-in had not shown. The admission was redesigned (slot documents, records before counters) and the stand-in now randomises the order of concurrent operations.

Ten deliberate faults were introduced one at a time (for example: no session check on a job, no quota check, no lease check, no size check, a new artifact ID on every retry). The suite failed on each.

**Not tested:** anything against Vercel Blob itself; a real browser; a 10-file, 150 MB batch through a real network.

## 14–15. Performance

Measured on a development machine and on a GitHub Actions runner, not on Vercel. Full tables: `docs/capacity-benchmark.md`.

| | Development machine (Xeon 2.6 GHz) | GitHub runner (EPYC) | Peak memory |
| --- | --- | --- | --- |
| 1 MB, 2 MP | 0.4 s | 0.3 s | 0.2 GB |
| 10 MB, 12 MP | 2.0 s | 1.4 s | 0.4 GB |
| 25 MB, 39 MP | 6.8 s | 4.6 s | 0.75 GB |
| 40 MP → WebP | 7.0 s | 4.9 s | 0.8 GB |
| 16 MP → AVIF | 13.4 s | 8.1 s | 0.7 GB |
| 10 files, 83 MB, one job | 15.6 s | 10.5 s | 0.6 GB |
| Two jobs at once, 6 × 10 MB | 12.3 s | 8.4 s | 0.4 GB |

- A 40 MP image stays under 1 GB because files are converted one at a time. A Hobby function has 2 GB.
- AVIF at 40 MP took 63 s and 1.4 GB in an isolated measurement, so AVIF output is limited to 16 MP.
- First and second run in a process took the same time. A function's cold start was not measured.
- A 100-byte PNG whose header claims 900 MP is rejected in milliseconds, before any pixel is decoded.

## 16. Cost and quota safeguards

Storage per session, jobs per session, an application-wide storage budget and a daily upload budget, all enforced with single conditional writes. A rate limit counted in the database. Storage-side expiry on every object. Daily counters of uploads, conversions, conversion time, downloads, failures and retries, with a warning flag at 80 % of a budget, at `GET /api/v1/internal/usage`. Limits are environment variables; the interface reads them from the server, so changing one needs a redeploy but no code change.

Not built: a per-job cost figure in currency, and reading the storage provider's own usage numbers.

## 17. Vercel build and deployment

- Preview builds of this branch: **succeed** on both Vercel projects, with `maxDuration: 300` and the daily schedule in `vercel.json`.
- Preview runtime: **not exercised** (behind Vercel's login).
- Production: **serves an old deployment**; every `/api` path answers 404.
- Netlify sites: run `main`; the API answers; MongoDB is refused (`network_access_denied`).

## 18. Environment variables

Needed for the high-capacity mode: `MONGODB_URI` (working), `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`. Everything else has a default; all variables the code reads are in `.env.example`.

Note for existing deployments: `OW_MAX_FILE_MB`, `OW_MAX_FILES`, `OW_MAX_BATCH_MB`, `OW_MAX_ARTIFACT_MB` and `OW_MAX_ZIP_MB` now describe direct uploads. If a host still sets them to the old small values, remove them. The request path reads `OW_REQUEST_*`.

## Feature classification

| Feature | Status |
| --- | --- |
| Standard upload inside the request, with downloads when storage fails | VERIFIED WORKING (CI) |
| Job admission, limits, quotas, idempotency, shared rate limit | VERIFIED WORKING (CI, MongoDB) |
| Upload authorization bound to path, size, type, session and time | VERIFIED WORKING on the local driver; the Vercel Blob token is IMPLEMENTED BUT UNVERIFIED |
| Upload confirmation: size, file signature, duplicates | VERIFIED WORKING (CI, MongoDB) |
| Worker: claims, heartbeat, retries, recovery, cancellation, idempotent output | VERIFIED WORKING (CI, MongoDB) |
| Worker started by `waitUntil` inside a Vercel function | IMPLEMENTED BUT UNVERIFIED |
| Daily scheduled cleanup and recovery on Vercel | BLOCKED BY CONFIGURATION (`CRON_SECRET`; production must serve this code) |
| Vercel Blob driver (private store) | BLOCKED BY CONFIGURATION (no store) and UNVERIFIED |
| Streamed download and streamed ZIP | VERIFIED WORKING against a Node server; through a Vercel function IMPLEMENTED BUT UNVERIFIED |
| Retention and cleanup, counters repair | VERIFIED WORKING (CI, MongoDB) |
| History with background jobs, delete, clear | VERIFIED WORKING (CI, MongoDB) |
| Storage usage page and panel | VERIFIED WORKING at API level; screen IMPLEMENTED BUT UNVERIFIED (typechecked, no screen test) |
| Image Optimizer in direct mode | VERIFIED WORKING in jsdom; real browser and the Blob upload client UNVERIFIED |
| CSS input up to 1 MB | IMPLEMENTED BUT UNVERIFIED beyond the existing CSS tests |
| Asset Analyzer: 10 files, send all to the optimizer | PARTIALLY IMPLEMENTED: the files still travel inside the request, so 3.8 MB in total; no screen test |
| Website audit: 3 pages, 25 resources, budgets | VERIFIED WORKING for the limits (made-up site) and for a real public page (CI); a real multi-page site was not audited |
| Limits shown from the server everywhere | VERIFIED WORKING for the optimizer; Settings and landing page typechecked only |
| Vercel Workflows, Vercel Queues | NOT IMPLEMENTED (reasons in section 7) |
| Advanced capacity mode | NOT IMPLEMENTED (flag reported, raises nothing) |
| ZIP exports stored for 24 hours | NOT IMPLEMENTED (ZIPs are streamed, not stored) |
| Upload completion callback from Vercel Blob | NOT IMPLEMENTED (the browser confirms; the daily sweep accepts uploads that arrived unconfirmed) |
| Limits adjustable without a redeploy | NOT IMPLEMENTED (environment variables) |
| Malware scanning | NOT IMPLEMENTED (files are only ever decoded as images, never executed or served as anything else) |
| Load test on the deployed runtime, 10 × 25 MB over a network | NOT DONE |
