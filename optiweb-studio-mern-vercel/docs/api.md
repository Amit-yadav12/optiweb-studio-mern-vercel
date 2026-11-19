# OptiWeb Studio — API reference

Base: `/api/v1`. Guest session is issued automatically via the `ow_sid` httpOnly cookie; all
records are scoped to it.

**Envelope**

```jsonc
// success
{ "ok": true, "data": T, "meta": { "requestId": string, "rateLimit": { "limit": n, "remaining": n } } }
// failure
{ "ok": false, "error": { "code": string, "message": string, "hint"?: string, "details"?: unknown }, "meta": { "requestId": string } }
```

**Error codes**

| Code | HTTP | Meaning |
| --- | --- | --- |
| `bad_request` | 400 | Malformed request body or missing files |
| `validation_error` | 422 | zod schema violation (field-level `details`) |
| `payload_too_large` | 413 | File above the size limit |
| `too_many_files` | 413 | More files than the batch limit |
| `unsupported_media_type` | 415 | Decoder rejected the content (corrupt/SVG, etc.) |
| `rate_limited` | 429 | `Retry-After` header present |
| `not_found` | 404 | Resource absent or owned by another session |
| `unprocessable_entity` | 422 | Transform failed (timeout, encoder) |
| `storage_unavailable` | 503 | Database unreachable where required |

---

### GET /api/v1/health

Probes the database and sharp. Always answers HTTP 200; `data.ok` is true only when the database is ready for reads and writes (`data.database.ready`). When it is not, `data.database.category` names the cause.

### POST /api/v1/images/optimize (also /images/optimize/batch)

`multipart/form-data`

| Field | Type | Notes |
| --- | --- | --- |
| `files` | file[] | 1–8 images; JPEG/PNG/WebP/AVIF/GIF/TIFF ≤ 10 MB each |
| `format` | string | `webp` (default) · `avif` · `jpeg` · `png` · `original` |
| `quality` | int | 30–100 (default 78) |
| `maxWidth` / `maxHeight` | int? | 16–8000; scaled down only, aspect preserved |

Response `data`:

```jsonc
{
  "jobId": string,           // History ID; empty when nothing was stored
  "status": "completed | partial | failed",   // the conversion
  "persisted": boolean,      // same value as storage.persisted
  "storage": { "persisted": true } | { "persisted": false, "category": string, "message": string, "hint": string },
  "results": [{
    "id": string,            // identifies the result in this response; not a download ID
    "artifactId": string | null,   // stored output file, served by GET /api/v1/artifacts/:id
    "inlineOutput"?: { "encoding": "base64", "contentType": string, "bytes": 0, "data": string } | null,
    "inlineSkipped"?: "too_large",
    "filename": string,      // safe original name
    "status": "completed | failed",
    "inputBytes": 0, "outputBytes": 0, "savedBytes": 0, "savingsPercent": 0,
    "inputWidth": 0, "inputHeight": 0, "outputWidth": 0, "outputHeight": 0,
    "outputFormat": "webp", "durationMs": 0,
    "errorCode"?: string, "message"?: string   // failed files only
  }],
  "totals": { "inputBytes": 0, "outputBytes": 0, "savedBytes": 0, "savingsPercent": 0 }
}
```

Per-file failures never abort the batch; `status: "partial"` summarises them.

A converted file has exactly one of two downloads. When the job was stored (`persisted: true`), `artifactId` names the stored file. When it was not, `artifactId` is null and `inlineOutput` holds the file itself, Base64-encoded, with `bytes` equal to `outputBytes`; the server keeps no copy. One response carries at most 3 MB of such files (`OW_MAX_INLINE_MB` can lower this). A file beyond that has `inlineOutput: null` and `inlineSkipped: "too_large"`. See "Storage diagnostics" in `deployment.md` for the `storage` categories.

### Direct uploads and background jobs

Available when `GET /api/v1/limits` reports `image.mode: "direct"`. Otherwise these endpoints answer 503 `direct_uploads_unavailable`. Every endpoint acts on the session in the request's cookie only; an ID that belongs to another session answers 404.

| Endpoint | Purpose | Success |
| --- | --- | --- |
| `POST /api/v1/jobs/image-optimization` | Admit a job. Body: `{ files: [{ name, type, size }], settings?, idempotencyKey? }`. Checks count, sizes, types, quota and job slots; reserves the storage. Nothing is uploaded yet. | 201, or 200 with `replayed: true` when the idempotency key (body, or `Idempotency-Key` header) was used before |
| `POST /api/v1/uploads/token` | Body `{ uploadId }` (an item ID of the job). Returns what the browser needs to upload that one file to storage: a client token bound to a server-generated path, the declared size and content type, valid for 20 minutes. Can be requested again to retry an upload. | 200 |
| `POST /api/v1/uploads/complete` | Body `{ uploadId }`. The server looks the object up in storage, compares its size with the declared size and checks its file signature; a file that fails is deleted. Repeating the call changes nothing. | 202 when this confirmation queued the job, else 200 |
| `DELETE /api/v1/uploads/:id` | Remove a file from a job that is still uploading. | 200 |
| `GET /api/v1/jobs/:id` | The job: `state`, real counts (`awaitingUpload`, `waiting`, `processing`, `completed`, `failed`, `cancelled`), totals over converted files, and each file with its result or error. No percentage is reported. | 200 |
| `POST /api/v1/jobs/:id/cancel` | Stop the job. A job that no worker holds is cancelled at once; otherwise the worker stops after the file in progress. Converted files stay available. | 200 |
| `POST /api/v1/jobs/:id/retry` | Run the failed files again whose failure was temporary and whose source is still stored. | 202 |
| `GET /api/v1/artifacts/:id/status` | `available` or `expired`, with size and expiry, without downloading. | 200 |
| `GET /api/v1/artifacts/zip?ids=a,b,c` | The same ZIP as the POST form, as a plain link; streamed. | 200 |
| `GET /api/v1/usage` | The session's storage use, quota, jobs in progress, files expiring soon, recent jobs, retention periods. | 200 |

Job states: `created` → `uploading` → `uploaded` → `queued` → `processing` → `completed` | `partial` | `failed`, and `cancelled` from any state before the end.

Errors use the common envelope. Codes specific to this pipeline: 403 `quota_exceeded`, 409 `conflict` (for example, confirming a file that has not arrived), 413 `payload_too_large` and `too_many_files`, 415 `unsupported_media_type`, 429 `too_many_active_jobs` and `rate_limited`, 503 `capacity_exhausted`, `direct_uploads_unavailable` and `storage_unavailable`.

`GET /api/v1/artifacts/:id` serves a file from object storage as a stream, with `Content-Length`, to the session that owns it. `GET /api/v1/limits` carries `image` (the limits of the mode in effect) and `advancedCapacity`.

### POST /api/v1/css/analyze

Body `{ "css": string }` (≤ 400k chars). Returns counts of `@font-face` rules, how many declare
`font-display`, how many are malformed, and findings with line numbers. Read-only.

### POST /api/v1/css/patch-font-display

Body `{ "css": string, "policy": "auto | block | swap | fallback | optional" }`.

Returns the patched stylesheet (`output`), `changedLines` (line numbers inserted),
`rulesPatched`, byte counts, the same analysis, and `artifactId` (stored copy) when persistence
is available. Malformed CSS is returned unchanged with `analysis.parseErrors` populated.

### POST /api/v1/assets/analyze

`multipart/form-data`: `files` (images and/or `.css`, ≤ 8) and optional `thresholdKb` (50–10000,
default from the session's preferences). Returns per-file metadata (true dimensions for images),
findings with `evidence` / `recommendation`, and a `heuristic` flag.

### GET /api/v1/history

Query: `q`, `kind` (`image.optimize | css.font-display | asset.analyze`), `status`, `sort`
(`newest | oldest | saved`), `page`, `pageSize` (5–50). Returns paginated entries plus a
`summary` aggregate for the session.

### GET /api/v1/history/:id · DELETE /api/v1/history/:id

Detail returns the job header and per-file rows (`hasArtifact` flags downloadable files).
DELETE removes the job and cascades its items/artifacts.

### DELETE /api/v1/history

Clears the whole session (records + artifacts).

### GET /api/v1/artifacts/:id

Streams a stored result (`image/*` or `text/css`). `?inline=1` serves it for `<img>` previews.
Content-Disposition is set from the stored (server-generated) filename.

### POST /api/v1/artifacts/zip

Body `{ "ids": string[], "name"?: string }`. Returns a DEFLATE ZIP with an
`optiweb-manifest.txt` documenting each file's measured byte length. Only ids owned by the
caller's session are bundled.

### GET /api/v1/preferences · PUT /api/v1/preferences

Session defaults: `defaultImageFormat`, `defaultQuality` (30–100), `defaultMaxWidth`,
`fontDisplayPolicy`, `analyzerThresholdKb` (50–10000), `reduceMotion`.

### GET /api/v1/session

Resolves (and issues) the guest session; returns the id, a short display code and mode.
