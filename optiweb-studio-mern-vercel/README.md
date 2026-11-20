# Unikit Studio

Web-asset tools that run in your browser. Images are converted, stylesheets are
patched and asset files are inspected by the page itself: the files you select
are never uploaded.

| Tool | What it does | Where it runs |
| --- | --- | --- |
| Image Optimizer | Re-encodes images to WebP, AVIF, JPEG or PNG, caps dimensions, reports real output sizes, builds a ZIP | Your browser (a Web Worker of the tab) |
| Font Optimizer | Finds `@font-face` rules without `font-display`, shows the exact change, gives the patched stylesheet | Your browser |
| Asset Analyzer | Reads format, dimensions, weight and metadata from file headers | Your browser |
| Website Audit | Fetches a public page and reports the resources it names | The server: a browser may not read another site's pages |

Earlier versions of this project (named OptiWeb Studio) uploaded images to a
server, converted them there and stored results in a database and in object
storage. All of that is gone. See [What changed in 2.0](#what-changed-in-20).

## How a file is handled

1. You choose or drop a file. The page reads its first bytes and identifies it
   from them, not from its name: format, dimensions, animation, metadata.
2. The size check happens before anything is decoded. An image that would need
   more memory than the device can spare is refused from its header.
3. A Web Worker decodes the image, applies the EXIF rotation, resizes it if a
   limit is set, and encodes it. WebP, JPEG and PNG come from the browser's own
   encoder. AVIF comes from a WebAssembly encoder that this site serves and the
   page loads the first time AVIF is needed (3.3 MB, about 1 MB compressed in
   transit).
4. The result stays in the tab's memory. Downloads and the ZIP are made there.
   Leaving the page discards everything.

No request carries a file, a file name or a result. This is not a promise about
how the server treats uploads: the server has no endpoint that accepts one.

### What makes that checkable

- **The server cannot take a file.** It has two routes: a health check and
  `POST /api/v1/audits`, which reads a JSON body of at most 16 KB. There is no
  multipart parser, no database driver and no storage client in the
  dependencies. See [docs/api.md](docs/api.md).
- **The browser is told to refuse.** Every page is served with a
  Content-Security-Policy whose `connect-src`, `form-action` and `default-src`
  are `'self'`. A script on the page cannot send data to another origin.
- **A test watches the wire.** `npm run test:browser` drives the production
  build in a real Chrome through a recording proxy, optimizes images, and
  asserts that no request carried a body, a file name or image bytes. It also
  repeats the work with the network cut off.

You can check it yourself: open the browser's developer tools on the Network
tab and optimize an image.

## Image Optimizer in detail

- **Reads** JPEG, PNG, WebP, AVIF, GIF and BMP. A file the browser cannot decode
  (TIFF and HEIC in Chrome) is reported as such, with a hint.
- **Writes** WebP, AVIF, JPEG, PNG.
- **Strategies**
  - *Single*: write the chosen format. If the result is larger than the
    original, the row says so and "Keep original" is offered for that file.
  - *Best-effort*: encode each file as WebP, AVIF and (when it has no
    transparency) JPEG, and keep the smallest of them.
  - *No-regression*: as best-effort, but when no result is smaller than the
    original, the original file is kept unchanged. A result is never larger.
- **Quality** 30 to 100. **Maximum width and height** 16 to 16,000 px.
  Proportions are kept and an image is never enlarged.
- **Limits depend on the device**, because the device does the work:

  | Device memory | Largest source image | Largest AVIF output | Files at once |
  | --- | --- | --- | --- |
  | 2 GB or less | 24 MP | 8 MP | 1 |
  | up to 4 GB | 50 MP | 24 MP | up to 2 |
  | more | 100 MP | 40 MP | up to 4 |

  One processor core is always left for the page. A queue holds up to 300 files.
- **Cancel** stops the batch at once by terminating the workers, which is what
  frees their memory. Finished files keep their results.

What the conversion does to a file, so there are no surprises:

- Outputs are 8-bit sRGB. Wide-gamut and high-bit-depth sources are converted.
- Outputs carry no metadata: no EXIF, no GPS position, no colour profile. The
  EXIF rotation is applied to the pixels first, so the image still looks right.
- Animated images (GIF, APNG, animated WebP and AVIF) and SVG are refused
  rather than flattened to one frame.
- JPEG has no transparency: transparent areas become white.

## Run it locally

Requires Node 22.

```bash
npm ci
npm run dev        # the app on http://localhost:5173, the API on :5000
```

Production build and server:

```bash
npm run build      # typecheck, then build the app into dist/
npm start          # serves dist/ and the API on PORT (default 5000)
```

No environment variable is required. [.env.example](.env.example) lists the
optional ones: a PageSpeed Insights key and the limits of the website audit.

## Tests

```bash
npm test                 # every suite; the browser suite if a browser is found
npm test -- --browser    # fail, instead of skip, when no browser is found
npm test -- unit api     # only the named suites
```

| Suite | Command | What it checks |
| --- | --- | --- |
| unit | `npm run test:unit` | Image header parser against real files, checks before decoding, planner, CSS and asset analysis, settings |
| pipeline | `npm run test:pipeline` | The steps of the image pipeline and the engine's scheduling, cancelling and fallback |
| ui | `npm run test:ui` | The result model: sizes, savings, kept originals, totals |
| dom | `npm run test:dom` | The Image Optimizer screen in a simulated DOM, from choosing files to the ZIP |
| audit | `npm run test:audit` | The website audit and its limits against a made-up site, with no network |
| api | `npm run test:api` | The HTTP contract: what is answered, what is refused, no cookies, no upload |
| security | `npm run test:security` | Source, dependencies, headers and the build: nothing that could send, receive or keep a file |
| function | `npm run test:function` | The Netlify function adapter |
| a11y | `npm run test:a11y` | Every page rendered: headings, landmarks, names, labels; colour contrast of the tokens |
| browser | `npm run test:browser` | The production build in a real Chrome: files never leave the tab; real outputs, sizes, rotation, limits, cancel |

The browser suite needs Chrome or Chromium. It looks for `CHROME_PATH`, then an
installed browser, then the `@sparticuz/chromium` package
(`npm install --no-save @sparticuz/chromium` brings its own). Set
`UNIKIT_TEST_DEVICE="cores=4,memory=8"` to run it as a device of that size.

`npm run smoke -- <url>` checks a running site through public requests:
see [docs/deployment.md](docs/deployment.md).

## Deployment

The app is a static site plus one small function. It is configured for Vercel
(`vercel.json`), Netlify (`../netlify.toml`) and any Node host (`npm start`).
There is nothing to provision: no database, no storage, no secret.
[docs/deployment.md](docs/deployment.md) has the details and the checks to run
after a deploy.

## Project layout

```
api/index.ts                 Vercel function entry
netlify/functions/api.ts     Netlify function entry
src/index.ts                 Node server entry (npm start)
src/app.ts                   The whole server: health, audit, refusals, static files
src/server/                  Audit service, address filter (SSRF), rate limit, headers
src/shared/                  Code used by both sides: image headers, CSS, asset analysis
src/features/images/engine/  Inspect, plan, pipeline, worker, engine
src/features/                The four tools and Settings
src/components/, src/lib/    Interface parts and helpers
public/                      Icons, manifest, theme script
scripts/                     Self-tests, fixtures, smoke test
docs/                        API, deployment, design tokens
```

## What changed in 2.0

- Image conversion, stylesheet patching and asset analysis moved from the
  server into the browser. The server-side image library, the database, object
  storage, sessions, cookies, quotas, background jobs and the scheduled cleanup
  were removed, with their endpoints. Old endpoints answer `410 Gone`.
- AVIF output is always available, through a WebAssembly encoder.
- History and Storage pages are gone: nothing is kept, so there is nothing to
  list. Their addresses explain this instead of failing.
- The product was renamed to Unikit Studio. The repository, the app directory
  and the hosting projects keep their earlier names, because the hosts are
  configured with them.
- Settings moved from the server to the browser's `localStorage`.

## Known limits

- Encoding speed and the largest image depend on the visitor's device.
- Chrome and Edge are the tested browsers (automated, Chromium). Firefox and
  Safari use the same code paths, with the WebAssembly WebP encoder where their
  canvas cannot write WebP; they are not covered by an automated test.
- The website audit reads HTML and the resources it names. It does not run the
  page's JavaScript.
