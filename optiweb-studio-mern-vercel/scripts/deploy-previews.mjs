#!/usr/bin/env node
/**
 * Finds the deploy previews that the hosts built for a commit.
 *
 *   node scripts/deploy-previews.mjs <owner/repo> <commit> [--wait <seconds>]
 *
 * A hosting provider that builds a preview of a pull request reports it on the
 * commit, as a status that carries the preview's address. This script waits
 * until those previews are built and prints the address of each one that can
 * be opened without signing in, one per line. CI hands the addresses to the
 * smoke test (deployed-smoke.mjs), so a change is checked on the hosts before
 * it is merged, not after.
 *
 *  - A preview that failed to build makes this script fail.
 *  - A preview behind a sign-in cannot be checked from outside. It is reported
 *    and left out.
 *  - No preview at all is not an error. The repository may not be connected to
 *    a host, or the commit may not belong to a pull request yet: a host builds
 *    previews for pull requests, so a commit pushed before its pull request
 *    was opened has none.
 *
 * Only Netlify's previews are listed. Vercel reports the address of its
 * dashboard instead of the preview's, and its previews ask for a sign-in.
 *
 * Addresses go to standard output and everything else to standard error, so
 * the output can be used as a list. GITHUB_TOKEN is used when set.
 */
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const [repository, commit] = args.filter((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--wait");
const waitIndex = args.indexOf("--wait");
const waitSeconds = waitIndex >= 0 ? Number(args[waitIndex + 1]) || 0 : 0;

if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !/^[0-9a-f]{7,40}$/i.test(commit ?? "")) {
  console.error("Usage: node scripts/deploy-previews.mjs <owner/repo> <commit> [--wait <seconds>]");
  process.exit(2);
}

const TITLE = "deploy-previews";
const PREVIEW = /^netlify\/([^/]+)\/deploy-preview$/;
/** A host reports a preview within seconds of the push. After this long without one, there is none. */
const APPEAR_WITHIN_MS = 60_000;

/** A line for the log and, in GitHub Actions, an annotation that can be read from the Checks API. */
function say(level, message) {
  console.error(`${level === "error" ? "✗" : "·"} ${message}`);
  if (process.env.GITHUB_ACTIONS === "true") console.error(`::${level} title=${TITLE}::${message.replace(/%/g, "%25").replace(/\r?\n/g, " ")}`);
}

/** The previews reported on the commit. A request that fails is tried again; after three failures the script stops with the reason. */
async function previews() {
  let reason = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/commits/${commit}/status?per_page=100`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "unikit-studio-ci", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const body = await response.json();
        return (body.statuses ?? []).filter((status) => PREVIEW.test(status.context)).map((status) => ({ site: PREVIEW.exec(status.context)[1], state: status.state, url: String(status.target_url ?? "").replace(/\/+$/, "") }));
      }
      reason = `GitHub answered ${response.status}`;
    } catch (error) {
      reason = `GitHub could not be reached (${error.cause?.code ?? error.message})`;
    }
    if (attempt < 3) await sleep(5_000);
  }
  say("error", `The deploy previews of ${commit.slice(0, 7)} could not be listed: ${reason}.`);
  process.exit(1);
}

/**
 * Whether the preview asks for a sign-in. Only a clear answer counts: a preview
 * that is broken or cannot be reached is not "private", and goes to the smoke
 * test, which reports it.
 */
async function asksForSignIn(url) {
  try {
    const response = await fetch(`${url}/api/v1/health`, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    // A protected preview answers "not authorised", or sends the visitor to the host's own sign-in page.
    return response.status === 401 || response.status === 403 || new URL(response.url).host !== new URL(url).host;
  } catch {
    return false;
  }
}

const started = Date.now();
const deadline = started + waitSeconds * 1000;
let found = await previews();
while ((found.length === 0 && Date.now() - started < Math.min(APPEAR_WITHIN_MS, waitSeconds * 1000)) || (found.some((preview) => preview.state === "pending") && Date.now() < deadline)) {
  console.error(found.length === 0 ? "… no deploy preview reported yet" : `… still building: ${found.filter((preview) => preview.state === "pending").map((preview) => preview.site).join(", ")}`);
  await sleep(10_000);
  found = await previews();
}

if (found.length === 0) {
  say("notice", `No deploy preview was reported for ${commit.slice(0, 7)}, so no deployed copy of it was checked. Hosts build previews for pull requests: a commit pushed before its pull request was opened has none.`);
  process.exit(0);
}

let failed = false;
for (const preview of found) {
  if (preview.state === "pending") {
    failed = true;
    say("error", `The deploy preview of ${preview.site} was still building after ${waitSeconds} seconds.`);
  } else if (preview.state !== "success" || !/^https:\/\//.test(preview.url)) {
    failed = true;
    say("error", `The deploy preview of ${preview.site} failed to build (${preview.state}). ${preview.url}`);
  } else if (await asksForSignIn(preview.url)) {
    say("notice", `${preview.url} asks for a sign-in, so it was not checked.`);
  } else {
    console.log(preview.url);
  }
}
process.exit(failed ? 1 : 0);
