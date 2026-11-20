# Release status: Unikit Studio 2.0

Date: 2026-11-20. Branch: `arena/09d3efa7-optiweb-studio-mern-vercel`.
Pull request: #6.

## Verdict

**The code is ready to merge. Two deployed previews of it pass every check.
Production has not run it yet.**

Everything that can be checked from a build has been checked in real browsers,
in the development sandbox and on GitHub. Two Netlify previews of the pull
request pass the smoke test. What remains is outside the repository: the
Vercel production address is still assigned to an old deployment and has to be
promoted by hand (see "To do on the hosts").

## What this release is

Images, stylesheets and asset files are processed in the visitor's browser.
The server keeps one job, the Website Audit, and has no endpoint that accepts a
file. The database, object storage, sessions, cookies, quotas, background jobs
and the scheduled cleanup are removed. The product is renamed from OptiWeb
Studio to Unikit Studio. Details: [README.md](README.md).

## Verified, and how

| Suite | Checks | Result |
| --- | --- | --- |
| unit | 160 | pass |
| pipeline | 83 | pass |
| ui | 43 | pass |
| dom | 75 | pass |
| audit | 26 | pass |
| api | 62 | pass |
| security | 57 | pass |
| function | 23 | pass |
| a11y | 35 | pass |
| browser | 181 | pass |

All ten pass in the development sandbox (Node 22, 2 processor cores, 4 GB of
memory) and in GitHub Actions. Typecheck and lint are clean.

### In browsers

The browser suite drives the production build, served by the real server. It
passed in three browsers:

| Browser | Where | Result |
| --- | --- | --- |
| Chrome 158, headless shell (the browser CI uses) | GitHub Actions | 181 of 181 |
| Google Chrome 157, the full browser | GitHub Actions | 181 of 181 |
| Chromium 153, headless shell | sandbox | 181 of 181, as a 2-core and as a 4-core, 8 GB device |

What it established:

- **Nothing is uploaded.** In the headless shell the whole browser made 48
  requests. 47 were `GET`s for the app's own pages and code. One was the `POST`
  of the Website Audit: 51 bytes of JSON, a URL and a page count. No request
  carried image bytes, a file name, a multipart body or a result, and none
  went to another host. In the full Chrome the app made 48 again, and the
  browser added 21 `GET`s for the page's own icon and manifest, which a full
  browser fetches by itself.
- **The record would have shown it.** At the end of each run, a blank page in
  the same browser context posts to another host. The record holds that
  request, body included. The silence before it is not blindness.
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
  to another origin, made from the page, are refused by the browser.
- **The paths for other browsers work.** With workers or worker canvases taken
  away, the page does the work itself. With a canvas that cannot write WebP,
  as in Safari, the WebAssembly encoder writes it: a real 800 × 600 WebP of
  87.7 KB from a 160.7 KB photo, with transparency kept where there is some.

Measured sizes at quality 78 (bytes), in the sandbox's Chromium 153:

| Source | WebP | AVIF | JPEG | PNG |
| --- | --- | --- | --- | --- |
| `photo-800x600.jpg`, 164,543 | 90,174 | 128,079 | 68,866 | 854,307 |
| `flat-600x400.png`, 670 | 1,438 | 624 | 4,994 | n/a |
| `alpha-320x200.png`, 65,965 | 5,512 | 2,536 | n/a | n/a |

A 12-megapixel photo (a 5.4 MB JPEG) took 2.2 s as WebP, 3.2 s as AVIF (4.1 s
the first time, when the encoder is loaded) and 0.3 s as JPEG in the sandbox.
The flat PNG shows why the app reports growth instead of hiding it: WebP and
JPEG are larger than the 670-byte original.

### On the hosts

CI ran the smoke test against the deploy previews of the pull request
(commit `6b9e55d`):

| Preview | Result |
| --- | --- |
| Netlify `rad-griffin-600eb2` | 31 of 31 |
| Netlify `transcendent-biscuit-aa643c` | 31 of 31 |
| Netlify `optiweb-studio-0` | not checked: its previews ask for a sign-in |
| Vercel, both projects | not checked: their previews ask for a sign-in. Both built without error. |

Each of the two serves the app script of the commit and the API of this
version, with the security policy in force. Each refused an upload at the old
endpoint, at the audit endpoint and at a page address. Each audited its own
home page: 8 resources, 347 KB, in under half a second.

In the sandbox the audit could read a real page (`https://github.com/`,
537 KB) but none of the 25 resources that page names, because the sandbox's
network reaches only a few hosts. On the previews it read the page and its
resources.

## What the first run on GitHub uncovered

The first CI run of the pull request failed 5 of 176 browser checks. The app
was not at fault. The test was, in four ways, and each is fixed:

1. **One record for two senders.** GitHub's runner has a full Google Chrome,
   which calls Google's services by itself, whatever page is open. One proxy
   for the whole browser counted those calls against the app. The app now runs
   in a browser context with a proxy of its own, and the rest of the browser
   uses a second one that refuses everything.
2. **The sandbox browser ran with its security relaxed.** The packaged
   Chromium suggests switches that turn off the same-origin policy and give
   every page `SharedArrayBuffer`, and the launcher passed them on. They are
   gone. Every result was measured again under normal switches. The sizes are
   unchanged; the times above are the new ones.
3. **A race in the keyboard test**, which those switches had hidden: the key
   press could arrive before the request to report the file chooser.
4. **Two checks that depended on timing or on the kind of browser.** One
   looked for stopped workers after a fixed pause. One counted a full
   browser's fetch of the page's icon as a request of the app.

Three services of Chrome work inside every browsing context, so their calls
reached the app's record: autofill lookups, a connection kept open to the
search engine, and an "AI Mode" availability check. Each was identified from
the log Chrome keeps of its own network activity and from Chromium's source,
none is caused by a page, and each is switched off for the test. CI uses
Chrome's headless shell, which has no services of its own, so a new service in
a later Chrome cannot fail it.

CI also gained a check: on a pull request branch it now runs the smoke test
against the deploy previews of the commit. That is how the table above was
made.

## Not verified

- **Production.** The Vercel production address still serves a deployment of
  the first commit. See "To do on the hosts".
- **The previews that ask for a sign-in**: Vercel's, and those of the Netlify
  site `optiweb-studio-0`. The Vercel connector has no access to the team's
  projects, so build logs and settings could not be read either.
- **Firefox and Safari.** The automated browsers are Chrome and Chromium. The
  paths those browsers need are tested by taking the feature away from
  Chromium, not in those browsers.
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
- A commit pushed before its pull request is opened has no deploy previews,
  so CI has no deployed copy of it to check. The next push is checked.
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
4. The CI run on `main` checks production with the smoke test, in its job
   "Deployed site serves this build". It fails until step 1 is done. Run it
   again afterwards: Actions → CI → Run workflow.
