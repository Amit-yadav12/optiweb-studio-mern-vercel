# Unikit Studio: deployment

The app is a static site and one small function. There is nothing to
provision: no database, no object storage, no scheduled job and no secret.
Every environment variable is optional.

| Part | What it is | Built from |
| --- | --- | --- |
| The app | Static files in `dist/`: HTML, scripts, styles, fonts, the image worker and the WebAssembly encoders | `npm run build` |
| The API | One function that answers the health check and runs the Website Audit | `src/app.ts` |

The repository holds the app in the nested directory
`optiweb-studio-mern-vercel/`. The directory keeps its earlier name because the
hosting projects are configured with it. Renaming it means changing the Root
Directory (Vercel) or the base in `netlify.toml` (Netlify) in the same step.

## Vercel

Project settings:

- **Root Directory:** `optiweb-studio-mern-vercel`
- Everything else comes from `vercel.json`: the Vite preset, `npm ci`,
  `npm run build`, output `dist`, and the function `api/index.ts` with a
  60-second limit.

Routing in `vercel.json`:

- `/api/*` goes to the function.
- Every other path that is not a file goes to `index.html`, except paths under
  `/assets/`: a build file that does not exist is a 404, never the app's page.
- Files under `/assets/` are cached for a year (their names contain a hash).
- Every response carries the security headers listed in [api.md](api.md).

## Netlify

`netlify.toml` at the repository root is the whole configuration: base
directory, build command, publish directory, the function directory, the
redirect of `/api/*` to the function, the 404 for missing build files, the
fallback to `index.html`, and the same headers. If a build setting in the
Netlify UI overrides the file, remove the override.

The function is bundled with esbuild; `express` is kept as an external module.
Netlify gives a function that answers a request 60 seconds, and that cannot be
configured. An audit stops itself after 45 seconds.

## Any Node host

```bash
npm ci
npm run build
npm start        # serves dist/ and the API on PORT (default 5000)
```

`src/index.ts` is the entry. The same Express app serves the static files with
the same headers and cache rules.

## Environment variables

None is required. The full list, with defaults, is in
[.env.example](../.env.example).

| Variable | Effect |
| --- | --- |
| `PAGESPEED_API_KEY` | The audit also reports Lighthouse lab scores and Chrome field data. Server-side only: do not prefix it with `VITE_`. |
| `UNIKIT_AUDIT_*` | Limits of one audit. See [api.md](api.md#limits-of-one-audit). |
| `PORT` | Port of the Node server. Ignored on Vercel and Netlify. |
| `SITE_URL` | Build time: the public address, for the absolute URL of the social preview image. Detected automatically on Vercel and Netlify. |

### Variables to delete on an existing deployment

Earlier versions needed a database and object storage. The app no longer reads
any of these, so they can be removed from the host's settings:

`MONGODB_URI`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`, `CLIENT_ORIGIN`,
`VITE_API_BASE_URL`, and every `OW_STORAGE_*`, `OW_REQUEST_*`, `OW_MONGO_*`,
`OW_WORKER_*` and other upload, quota or job setting.

If a database password or storage token was ever shared outside the host's
settings, rotate it at the provider even though the app no longer uses it.

The audit limits were renamed from `OW_AUDIT_*` to `UNIKIT_AUDIT_*`. The old
names are still read.

## Check a deployment

```bash
npm run build                              # so the script knows this build
npm run smoke -- https://your-site.example --expect-build --wait 600
npm run smoke -- https://your-site.example --audit https://github.com/   # see below
```

The smoke test uses public requests only and changes nothing on the site. It
checks that:

- the site serves the app script of this build (`--expect-build`; `--wait`
  keeps trying while a deployment is in progress);
- a deep link such as `/app/images` loads the app;
- the security policy is in force, and the page sets no cookie;
- a build file that does not exist is a 404, not the app's page;
- every script the app refers to is served, and the WebAssembly encoders are
  served as `application/wasm`;
- the API answers, and it is the API of this version: it accepts no file and
  stores nothing;
- an upload is refused, at the old endpoint, at the audit endpoint and at a
  page address;
- the audit refuses a loopback address and the cloud metadata address, and, on
  a public site, can audit the site's own home page.

The files of the site's own home page are all on one host. Most pages keep
theirs on others. `--audit <page>` asks the site to audit a page of your
choice and reports how many of that page's resources on other hosts the audit
could read. It is an observation and never fails the test: the page is someone
else's, and it may be slow, down, or refuse the request.

CI runs the same script on every push:

- against the server started on the runner;
- on a pull request branch, against the **deploy previews** that Netlify
  built for the commit, so a change is checked on a host before it is merged;
- on `main`, against production.

On the deployed copies CI passes `--audit` with the repository's page on
GitHub, and the result is in the job's notices.

The previews are found from the statuses that Netlify reports on the commit
(`scripts/deploy-previews.mjs`). A preview that failed to build fails the job.
A preview that asks for a sign-in cannot be checked from outside: the job names
it in a notice and leaves it out. Vercel's previews are not looked for at all:
this project's ask for a sign-in (Vercel's deployment protection), and the
status Vercel reports on a commit carries the address of its dashboard, not of
the preview. Whether they built is shown on the pull request. A commit pushed
before its pull request was opened has no previews: the job passes with a
notice that no deployed copy was checked, and the next push is checked.

To check any other address, start the workflow by hand and give it:

```bash
gh workflow run ci.yml --ref <branch> -f url=https://your-site.example
```

The production address CI checks is the repository variable `PRODUCTION_URL`
(several addresses may be given, separated by spaces).

## When the site does not serve the new build

The smoke test names the app script the site serves. If it is not the script
of the current build after the deployment has finished, the address is assigned
to an older deployment. No change to the repository fixes that:

- **Vercel:** Project → Deployments → the newest deployment of `main` →
  **Promote to Production** (or **Undo Rollback**, if that is offered). After a
  rollback, Vercel stops assigning new deployments to the production address
  until a deployment is promoted again.
- **Netlify:** Deploys → the newest deploy of `main` → **Publish deploy**, and
  unlock auto publishing if a deploy is locked.

Signs of an old deployment: `/api/v1/health` is answered by the host's own
"not found" page, or its JSON has a `database` field; the page title is not
"Unikit Studio".

## What the hosts cannot change

The privacy of the tools does not depend on host settings. The page does the
work, and the function has no code that reads a file. A misconfigured host can
break the site (missing headers, an old deployment), and the smoke test reports
that, but it cannot make the server receive files.
