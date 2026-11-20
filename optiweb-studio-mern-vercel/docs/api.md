# Unikit Studio: API

The server is small on purpose. It does the one thing a browser may not do,
which is to read another site's pages for the Website Audit. It accepts no
file, sets no cookie, has no session and stores nothing.

The source is one file, `src/app.ts`. `npm run test:api` checks every statement
on this page against the running server.

## Routes

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | Liveness for uptime monitors. Plain JSON, no envelope. |
| `GET /api/v1/health` | The same facts in the standard envelope. |
| `POST /api/v1/audits` | Audit a public page. JSON in, JSON out. |

Everything else under `/api` is refused:

| Request | Answer |
| --- | --- |
| Another method on a route above | `405 method_not_allowed`, with an `Allow` header |
| An endpoint of an earlier version: `/api/v1/images`, `assets`, `css`, `jobs`, `uploads`, `artifacts`, `history`, `usage`, `preferences`, `session`, `limits`, `internal` | `410 gone`. The request body is not read. |
| Any other path under `/api` | `404 not_found` |
| A method other than `GET` or `HEAD` on a page address | `405 method_not_allowed` |

## Envelope

Success:

```json
{ "ok": true, "data": { }, "meta": { "requestId": "3cb1d0be-…" } }
```

Failure:

```json
{
  "ok": false,
  "error": { "code": "validation_error", "message": "…", "hint": "…", "details": [] },
  "meta": { "requestId": "3cb1d0be-…" }
}
```

`hint` and `details` are present when there is something to add. Every answer
carries `X-Request-Id` with the same value as `meta.requestId`. A plain request
ID sent in `X-Request-Id` is kept, so one ID can follow a request through logs;
anything else is replaced by a new UUID. API answers are sent with
`Cache-Control: no-store`.

Error messages never contain the request body, a stack trace, a file path or an
internal address.

## Health

```
GET /api/v1/health
```

```json
{
  "ok": true,
  "data": {
    "ok": true,
    "service": "Unikit Studio",
    "version": "2.0.0",
    "processing": { "images": "browser", "stylesheets": "browser", "assets": "browser", "audit": "server" },
    "acceptsFileUploads": false,
    "storesFiles": false,
    "usesCookies": false,
    "audit": { "maxPages": 3, "maxResourcesPerPage": 25, "pagespeedConfigured": false },
    "uptimeSeconds": 12,
    "timestamp": "2026-11-20T07:22:29.278Z"
  },
  "meta": { "requestId": "…" }
}
```

Nothing in it depends on an outside service, so it answers whenever the
function runs. `GET /api/health` returns the `data` object alone.

## Website audit

```
POST /api/v1/audits
Content-Type: application/json

{ "url": "https://example.com/", "extraPages": 0 }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `url` | string, 8 to 2,048 characters | The page to audit. `http` or `https`, a public host, no user name or password. |
| `extraPages` | integer 0 to 2, default 0 | Further pages to inspect: the first links on the page that stay on the same site. |

The answer is a report: the document, every resource the HTML names (images,
stylesheets, fonts, scripts) with its status, type and transferred bytes,
totals, findings, and a `coverage` section that states what was and was not
looked at. `coverage.javascriptRendered` is always `false`: the audit reads
HTML and does not run scripts. Lighthouse and Chrome field data appear only
when `PAGESPEED_API_KEY` is set; otherwise the report says they are
unavailable. The report is returned and not kept.

### What the audit refuses

| Condition | Answer |
| --- | --- |
| `Content-Type` is not `application/json` (a form or a file upload, for example) | `415 unsupported_media_type` |
| Body larger than 16 KB | `413 payload_too_large` |
| Body is not valid JSON | `400 bad_request` |
| Body is not an object, or a field is missing or out of range | `422 validation_error`, with `details[].path` (a bare JSON string is refused with `400`) |
| The URL is not `http(s)`, carries credentials, names a private address, or its host does not resolve | `400 bad_request` |
| The host cannot be reached, answers too slowly, or sends more than the size limit | `422 unprocessable_entity` |
| More than 10 audits a minute from one address | `429 rate_limited`, with `Retry-After` |

### Which addresses are private

The audit fetches only public internet addresses. Refused, for the requested
URL and again for every redirect and every resource:

- loopback (`127.0.0.0/8`, `::1`), private ranges (`10/8`, `172.16/12`,
  `192.168/16`, `fc00::/7`), link-local (`169.254/16`, which includes cloud
  metadata at `169.254.169.254`, and `fe80::/10`), carrier-grade NAT
  (`100.64/10`), multicast, reserved and documentation ranges;
- IPv6 forms that carry an IPv4 address: IPv4-mapped (also written in hex),
  NAT64 and 6to4;
- host names that resolve to any of the above. The check is repeated at the
  moment a connection is opened, on the addresses that connection will use, so
  a name cannot pass the check and then resolve to something else. A name with
  both public and private addresses is refused.

### Limits of one audit

| Limit | Default | Environment variable (ceiling) |
| --- | --- | --- |
| Pages, the requested one included | 3 | `UNIKIT_AUDIT_MAX_PAGES` (3) |
| Resources fetched per page | 25 | `UNIKIT_AUDIT_MAX_RESOURCES` (25) |
| Largest page document read | 1 MB | `UNIKIT_AUDIT_MAX_HTML_MB` (1) |
| Largest resource read | 1 MB | `UNIKIT_AUDIT_MAX_RESOURCE_MB` (1) |
| Bytes read in total | 24 MB | `UNIKIT_AUDIT_MAX_TOTAL_MB` (48) |
| Time per request | 4 s | `UNIKIT_AUDIT_TIMEOUT_MS` (8,000) |
| Time for the whole audit | 45 s | `UNIKIT_AUDIT_TOTAL_TIMEOUT_MS` (120,000) |
| Time kept for PageSpeed Insights | 10 s | `UNIKIT_AUDIT_PAGESPEED_TIMEOUT_MS` (12,000) |

A limit that cuts an audit short is named in `coverage.stoppedBy`. A value
above its ceiling is ignored. Keep the whole-audit time below the host's
function limit (60 seconds as configured for Vercel).

The rate limit is counted in the memory of one server instance. On a
serverless host each instance counts separately, so it slows a single client
down but is not a hard quota.

## Response headers

Every response, from the server and from the static hosts, carries:

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |

`'wasm-unsafe-eval'` allows WebAssembly, which the AVIF encoder needs; it does
not allow `eval`. `blob:` and `data:` in `img-src` are for previews of results
that exist only in the tab.

The values are defined once, in `src/server/config/securityHeaders.ts`.
`vercel.json` and `netlify.toml` repeat them for the static files, and
`npm run test:security` fails when the three differ.
