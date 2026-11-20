# Release status: Unikit Studio 2.0

Date: 2026-11-20. Branch: `arena/09d3efa7-optiweb-studio-mern-vercel`.

## Verdict

**The code is ready to merge. It has not run on a production host yet.**

Everything that can be checked from a build has been checked, in a real
browser, with the results below. What remains is outside the repository: the
Vercel production address is still assigned to an old deployment and has to be
promoted by hand (see "To do on the hosts").

## What this release is

Images, stylesheets and asset files are processed in the visitor's browser.
The server keeps one job, the Website Audit, and has no endpoint that accepts a
file. The database, object storage, sessions, cookies, quotas, background jobs
and the scheduled cleanup are removed. The product is renamed from OptiWeb
Studio to Unikit Studio. Details: [README.md](README.md).

## Verified, and how

All of this ran in the development sandbox: Node 22, Chromium 153 (headless),
2 processor cores, 4 GB of memory.

| Suite | Checks | Result |
| --- | --- | --- |
| unit | 160 | pass |
| pipeline | 83 | pass |
| ui | 43 | pass |
| dom | 75 | pass |
| audit | 26 | pass |
| api | 62 | pass |
| security | 56 | pass |
| function | 23 | pass |
| a11y | 34 | pass |
| browser | 176 | pass |

Typecheck and lint are clean. The smoke test passes against the started
server (30 checks).

What the browser suite established, on the production build served by the real
server, with all traffic through a recording proxy:

- **Nothing is uploaded.** Over the whole run the browser made 48 requests.
  47 were `GET`s for the app's own files. One was the `POST` of the Website
  Audit: 51 bytes of JSON, a URL and a page count. No request carried image
  bytes, a file name, a multipart body or a result.
- **It works with the network cut.** Once the page and the encoder are loaded,
  images are converted with every request failing.
- **The outputs are real files.** Each is read back and identified from its
  bytes: format, dimensions, no metadata. The sizes on screen are the sizes of
  the files that are downloaded.
- **A larger result is reported as larger**, and the original is offered.
- **Rotation is applied and metadata is dropped.** A photo stored sideways with
  a GPS position comes out upright, with no EXIF and no position.
- **Limits hold.** A 69-byte PNG that declares 30,000 × 30,000 px is refused
  from its header, before anything is decoded.
- **Cancel works.** A batch of eight 12-megapixel AVIF encodes stops in well
  under a second; finished files keep their results; the queue can run again.
- **Concurrency is bounded.** Run as a 4-core, 8 GB device, never more than
  three files were in work at once.
- **Nothing is left behind.** Leaving the page releases every object URL and
  terminates every worker. Cookies, IndexedDB and the Cache API stay empty.
- **The security policy blocks other origins.** A `fetch` and an image request
  to another origin, made from the page, are refused by the browser, and no
  request to another host reached the network.
- **The paths for other browsers work.** With workers or worker canvases taken
  away, the page does the work itself. With a canvas that cannot write WebP,
  as in Safari, the WebAssembly encoder writes it: a real 800 × 600 WebP of
  87.7 KB from a 160.7 KB photo, with transparency kept where there is some.

Measured sizes at quality 78 (bytes):

| Source | WebP | AVIF | JPEG | PNG |
| --- | --- | --- | --- | --- |
| `photo-800x600.jpg`, 164,543 | 90,174 | 128,079 | 68,866 | 854,307 |
| `flat-600x400.png`, 670 | 1,438 | 624 | 4,994 | n/a |
| `alpha-320x200.png`, 65,965 | 5,512 | 2,536 | n/a | n/a |

A 12-megapixel photo took 1.5 s as WebP and 3.7 s as AVIF on this machine.
The flat PNG shows why the app reports growth instead of hiding it: WebP and
JPEG are larger than the 670-byte original.

The website audit was run once against a real site (`https://github.com/`)
through the real network code: the page was fetched and parsed, and the
resources it names were listed.

## Not verified

- **No deployed site has run this code.** Vercel preview deployments are behind
  Vercel's login. The Vercel connector has no access to the team's projects, so
  build logs and settings could not be read.
- **Firefox and Safari.** The automated browser is Chromium. The paths those
  browsers need are tested by taking the feature away from Chromium, not in
  those browsers.
- **Phones and low-memory devices.** The limits for 2 GB and 4 GB devices are
  tested as arithmetic and by telling the page it runs on such a device, not on
  real hardware.
- **Speed on other machines.** The times above are from one two-core machine.
- **Screen readers.** The accessibility suite checks structure and colour.
  Nobody has listened to the app.

## Known gaps

- Borders of inputs and secondary buttons are below the 3:1 contrast that
  WCAG 1.4.11 asks of a control's boundary. See
  [docs/design-tokens.md](docs/design-tokens.md).
- The rate limit of the audit is counted per server instance, so on a
  serverless host it slows one client down but is not a hard quota.
- The audit does not run a page's JavaScript.
- The repository, the app directory and the hosting projects keep the name
  "optiweb". The production address and the social preview URL carry it until
  the project or its domain is renamed on the host.

## To do on the hosts

1. **Vercel: promote the newest deployment of `main`.** Project → Deployments →
   newest `main` deployment → **Promote to Production** (or **Undo Rollback**).
   The production address has served a deployment from the first commit since
   2026-11-10 and ignores new ones until this is done. No change to the
   repository can fix it.
2. **Delete the variables the app no longer reads**: `MONGODB_URI`,
   `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`, `CLIENT_ORIGIN`,
   `VITE_API_BASE_URL`, and the `OW_STORAGE_*` and `OW_REQUEST_*` settings.
3. **Rotate the database password** that was shared earlier, at the provider.
   The app no longer uses the database, but the credential still works.
4. Then run the workflow "CI" on `main`: its job "Deployed site serves this
   build" checks production with the smoke test.
