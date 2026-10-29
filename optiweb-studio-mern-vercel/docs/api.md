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

Probes the database and sharp. Returns `ok` only when the database is reachable.

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
  "jobId": string, "status": "completed | partial | failed", "persisted": boolean,
  "results": [{
    "id": string,            // artifact id for downloads
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
