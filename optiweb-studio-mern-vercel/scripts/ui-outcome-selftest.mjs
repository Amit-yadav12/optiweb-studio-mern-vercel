#!/usr/bin/env node
/**
 * Outcome self-test for the image optimizer screen. Needs no browser, server
 * or database.
 *
 *   npm run test:ui
 *
 * It renders the real results panel to HTML for each kind of API response and
 * checks what a person is told and offered:
 *
 *  - converted and stored: downloads and a History link, built from the IDs of
 *    the stored files;
 *  - converted but not stored: the reason from the server, and no download,
 *    preview, ZIP or History link anywhere in the markup;
 *  - conversion failed: said as such, with nothing to download.
 *
 * It also checks that the three outcomes are told apart by title, tone and
 * icon, and that a response which contradicts itself is treated as not stored.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { createChecker } from "./lib/selftest-kit.mjs";

const { check, section, report, crashed } = createChecker("ui-outcome-selftest");
process.on("uncaughtException", (error) => { crashed(error); process.exit(1); });
process.on("unhandledRejection", (error) => { crashed(error); process.exit(1); });

const { describeImageOutcome, settleResult, storedArtifactId } = await import("../src/features/images/outcome.ts");
const { ImageReview } = await import("../src/features/images/ImageReview.tsx");
const { StorageNotice } = await import("../src/components/ui/StorageNotice.tsx");

/* ------------------------------------------------------------------ fixtures */

const JOB = "99999999-9999-4999-8999-999999999999";
const ARTIFACT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARTIFACT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** Per-response result IDs. They are not download IDs and must never appear in a link. */
const RESULT_ID_A = "0000000a-0000-4000-8000-00000000000a";
const RESULT_ID_B = "0000000b-0000-4000-8000-00000000000b";

const FAILURE = {
  persisted: false,
  category: "network_access_denied",
  message: "MongoDB refused the connection from this server.",
  hint: "In Atlas, open Network Access and allow this server.",
};

const converted = (filename, id, artifactId) => ({
  id: artifactId ?? id,
  artifactId,
  filename,
  outputFilename: filename.replace(/\.\w+$/, "-optiweb.webp"),
  status: "completed",
  inputContentType: "image/png",
  durationMs: 12,
  inputBytes: 1000,
  outputBytes: 400,
  savedBytes: 600,
  savingsPercent: 60,
  inputWidth: 40,
  inputHeight: 30,
  outputWidth: 40,
  outputHeight: 30,
  outputFormat: "webp",
});
const rejected = (filename) => ({
  id: "0000000c-0000-4000-8000-00000000000c",
  artifactId: null,
  filename,
  outputFilename: filename,
  status: "failed",
  errorCode: "unsupported_image",
  message: "This file is not a supported image.",
  inputContentType: "image/png",
  durationMs: 3,
  inputBytes: 20,
  outputBytes: 0,
  savedBytes: 0,
  savingsPercent: 0,
  inputWidth: null,
  inputHeight: null,
  outputWidth: null,
  outputHeight: null,
  outputFormat: null,
});

function responseOf(results, stored) {
  const done = results.filter((result) => result.status === "completed");
  const inputBytes = results.reduce((sum, result) => sum + result.inputBytes, 0);
  const outputBytes = done.reduce((sum, result) => sum + result.outputBytes, 0);
  return {
    jobId: stored ? JOB : "",
    persisted: stored,
    storage: stored ? { persisted: true } : FAILURE,
    status: done.length === 0 ? "failed" : done.length < results.length ? "partial" : "completed",
    results,
    totals: { inputBytes, outputBytes, savedBytes: done.reduce((sum, result) => sum + result.savedBytes, 0), savingsPercent: 60 },
  };
}

/** Queue entries exactly as the optimizer builds them: `settleResult` decides what each one may offer. */
const itemsOf = (response, earlier = []) => [
  ...earlier,
  ...response.results.map((result, index) => ({
    key: `item-${earlier.length + index}`,
    file: new File([new Uint8Array(8)], result.filename, { type: "image/png" }),
    preview: `blob:local-preview-${earlier.length + index}`,
    ...settleResult(response, result),
  })),
];

function render(response, items = itemsOf(response)) {
  const html = renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(ImageReview, { response, items, zipping: false, onDownloadAll() {}, onReset() {} })),
  );
  return {
    html,
    text: html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " "),
    hrefs: Array.from(html.matchAll(/href="([^"]*)"/g), (match) => match[1].replace(/&amp;/g, "&")),
    sources: Array.from(html.matchAll(/src="([^"]*)"/g), (match) => match[1].replace(/&amp;/g, "&")),
    noticeTone: /data-tone="([a-z]+)"/.exec(html)?.[1] ?? null,
  };
}

/** True when the markup offers nothing that depends on stored output. */
function offersNothingStored(view) {
  return (
    !view.html.includes("/api/v1/artifacts") &&
    !view.html.includes("/app/history") &&
    !view.html.includes("/app/assets?inspect") &&
    !view.text.includes("Download all") &&
    !/\sdownload(=|\s|>)/.test(view.html) &&
    view.sources.every((source) => source.startsWith("blob:"))
  );
}

const storedBoth = responseOf([converted("first.png", RESULT_ID_A, ARTIFACT_A), converted("second.png", RESULT_ID_B, ARTIFACT_B)], true);
const storedPartly = responseOf([converted("first.png", RESULT_ID_A, ARTIFACT_A), rejected("broken.png")], true);
const notStoredBoth = responseOf([converted("first.png", RESULT_ID_A, null), converted("second.png", RESULT_ID_B, null)], false);
const notStoredPartly = responseOf([converted("first.png", RESULT_ID_A, null), rejected("broken.png")], false);
const failedStored = responseOf([rejected("broken.png")], true);
const failedNotStored = responseOf([rejected("broken.png")], false);

/* ------------------------------------------------------ 1. outcome decision */
section("outcome for each combination of conversion and storage");
{
  const table = [
    ["all converted, stored", storedBoth, "stored", "ok", true, JOB],
    ["partly converted, stored", storedPartly, "stored", "warn", true, JOB],
    ["all converted, not stored", notStoredBoth, "converted_not_stored", "warn", false, null],
    ["partly converted, not stored", notStoredPartly, "converted_not_stored", "warn", false, null],
    ["nothing converted, job stored", failedStored, "conversion_failed", "danger", false, JOB],
    ["nothing converted, not stored", failedNotStored, "conversion_failed", "danger", false, null],
  ];
  for (const [name, response, kind, tone, downloads, historyJobId] of table) {
    const outcome = describeImageOutcome(response);
    check(
      `${name} → ${kind} (${tone})`,
      outcome.kind === kind && outcome.tone === tone && outcome.downloadsAvailable === downloads && outcome.historyJobId === historyJobId && outcome.toast.tone === tone,
      JSON.stringify({ kind: outcome.kind, tone: outcome.tone, downloads: outcome.downloadsAvailable, history: outcome.historyJobId }),
    );
  }
  const titles = new Set([storedBoth, notStoredBoth, failedStored].map((response) => describeImageOutcome(response).title));
  const toasts = new Set([storedBoth, notStoredBoth, failedStored].map((response) => describeImageOutcome(response).toast.title));
  check("the three outcomes have three different titles and three different toasts", titles.size === 3 && toasts.size === 3);
  const notStored = describeImageOutcome(notStoredBoth);
  check("not stored: the reason, hint and category come from the response", notStored.storageFailure?.message === FAILURE.message && notStored.storageFailure?.hint === FAILURE.hint && notStored.storageFailure?.category === FAILURE.category);
  check("not stored: the toast says so and gives the reason", notStored.toast.title === "Converted, but not stored" && notStored.toast.description?.includes(FAILURE.message) && notStored.toast.description?.includes("Nothing can be downloaded"));
  check("stored: there is no storage failure", describeImageOutcome(storedBoth).storageFailure === null && describeImageOutcome(storedBoth).storage.label === "Stored");
  check("badges name conversion and storage separately", notStored.conversion.label === "Converted" && notStored.storage.label === "Not stored" && describeImageOutcome(storedPartly).conversion.label === "Partly converted" && describeImageOutcome(failedStored).conversion.label === "Conversion failed");
}

section("a download ID is given only for a stored, converted file");
{
  const withStrayIds = responseOf([converted("first.png", RESULT_ID_A, ARTIFACT_A)], false); // says not stored, yet carries an ID
  const contradictory = { ...responseOf([converted("first.png", RESULT_ID_A, ARTIFACT_A)], true), storage: FAILURE };
  const flagOnly = { ...responseOf([converted("first.png", RESULT_ID_A, ARTIFACT_A)], false), storage: { persisted: true } };
  const noReason = { ...responseOf([converted("first.png", RESULT_ID_A, null)], false), storage: undefined };
  const missingId = responseOf([converted("first.png", RESULT_ID_A, null)], true);
  check("stored response, stored file → its artifactId", storedArtifactId(storedBoth, storedBoth.results[0]) === ARTIFACT_A);
  check("persisted: false wins over an artifactId in the result", storedArtifactId(withStrayIds, withStrayIds.results[0]) === null && describeImageOutcome(withStrayIds).kind === "converted_not_stored");
  check("storage.persisted: false wins over persisted: true", storedArtifactId(contradictory, contradictory.results[0]) === null && describeImageOutcome(contradictory).kind === "converted_not_stored");
  check("persisted: false wins over storage.persisted: true", storedArtifactId(flagOnly, flagOnly.results[0]) === null && describeImageOutcome(flagOnly).kind === "converted_not_stored");
  check("a stored response without an artifactId for a file gives that file no download", storedArtifactId(missingId, missingId.results[0]) === null);
  check("the per-response result id is never used as a download ID", storedArtifactId(notStoredBoth, notStoredBoth.results[0]) === null && notStoredBoth.results[0].id === RESULT_ID_A);
  check("a rejected file never has a download", storedArtifactId(storedPartly, storedPartly.results[1]) === null && settleResult(storedPartly, storedPartly.results[1]).status === "failed");
  check("a response without a reason still reads as not stored", describeImageOutcome(noReason).kind === "converted_not_stored" && describeImageOutcome(noReason).storageFailure?.message === "Storage is unavailable." && describeImageOutcome(noReason).storageFailure?.category === null);
  for (const [name, response] of [["persisted: false with a stray ID", withStrayIds], ["contradictory flags", contradictory]]) {
    check(`rendered markup for ${name} offers no download`, offersNothingStored(render(response)));
  }
}

/* --------------------------------------------------------- 2. rendered panel */
section("rendered: converted and stored");
{
  const view = render(storedBoth);
  check("the banner says “Converted and stored” in the ok tone", view.noticeTone === "ok" && view.text.includes("Converted and stored") && view.text.includes("All 2 files were converted and stored."));
  check("badges read Converted and Stored", />Converted<\/span>/.test(view.html) && />Stored<\/span>/.test(view.html) && !view.text.includes("Not stored"));
  for (const id of [ARTIFACT_A, ARTIFACT_B]) {
    check(`file ${id.slice(0, 8)}: the table and the card each link to the stored file's download`, view.hrefs.filter((href) => href === `/api/v1/artifacts/${id}?download=1`).length === 2);
    check(`file ${id.slice(0, 8)}: the preview and the Inspect link use the same ID`, view.sources.some((source) => source.startsWith(`/api/v1/artifacts/${id}`)) && view.hrefs.includes(`/app/assets?inspect=${id}`));
  }
  check("every artifact link points at a stored file", view.hrefs.filter((href) => href.startsWith("/api/v1/artifacts/")).every((href) => href.includes(ARTIFACT_A) || href.includes(ARTIFACT_B)));
  check("the ZIP download is offered", view.text.includes("Download all (ZIP)"));
  check("the banner links to the job in History", view.hrefs.includes(`/app/history/${JOB}`) && view.text.includes("Open this job in History"));
}

section("rendered: converted but not stored");
{
  const view = render(notStoredBoth);
  check("the banner says “Converted, but not stored” in the warn tone", view.noticeTone === "warn" && view.text.includes("Converted, but not stored"));
  check("it says the files cannot be downloaded and the run is not in History", view.text.includes("2 files were converted, but the output could not be stored. They cannot be downloaded, and this run is not in History."));
  check("it gives the server's reason, hint and category", view.text.includes(`Reason: ${FAILURE.message}`) && view.text.includes(FAILURE.hint) && view.text.includes(`Reference: ${FAILURE.category}`));
  check("badges read Converted and Not stored", />Converted<\/span>/.test(view.html) && />Not stored<\/span>/.test(view.html));
  check("no artifact URL, download attribute, ZIP button, Inspect link or History link is rendered", offersNothingStored(view), view.hrefs.join(" "));
  check("no result ID of the response appears anywhere in the markup", !view.html.includes(RESULT_ID_A) && !view.html.includes(RESULT_ID_B));
  check("each file says why it has no download", (view.text.match(/Not stored, so there is no file to download\./g) ?? []).length === 2 && (view.text.match(/No preview\. The converted file was not stored\./g) ?? []).length === 2);
  check("the measurements are still shown", view.text.includes("first.png") && view.text.includes("second.png") && view.text.includes("Weight comparison"));
  check("it does not claim anything was stored", !/converted and stored/i.test(view.text) && !view.text.includes("is in History") && !view.text.includes("can download") && !view.text.includes("can be downloaded"));
}

section("rendered: conversion failed");
{
  const view = render(failedStored);
  check("the banner says “Conversion failed” in the danger tone", view.noticeTone === "danger" && view.text.includes("Conversion failed") && view.text.includes("The file could not be converted. No output was produced, so there is nothing to download."));
  check("the rejected file is listed with its reason", view.text.includes("Rejected files") && view.text.includes("broken.png") && view.text.includes("This file is not a supported image."));
  check("nothing is offered for download", offersNothingStored(view));
  check("it is not presented as a storage problem", !view.text.includes("Converted, but not stored") && !view.text.includes("Reference:"));

  const both = render(failedNotStored);
  check("when storage also failed, the banner is still “Conversion failed”", both.noticeTone === "danger" && both.text.includes("Conversion failed") && !both.text.includes("Converted, but not stored"));
  check("the storage failure is a secondary remark", both.text.includes(`This attempt was not recorded in History either. ${FAILURE.message}`) && offersNothingStored(both));
}

section("rendered: partly converted");
{
  const stored = render(storedPartly);
  check("stored: warn tone, “1 of 2 files converted and stored”", stored.noticeTone === "warn" && stored.text.includes("1 of 2 files converted and stored") && />Partly converted<\/span>/.test(stored.html));
  check("stored: only the converted file has links", stored.hrefs.some((href) => href.startsWith(`/api/v1/artifacts/${ARTIFACT_A}`)) && stored.text.includes("Rejected files") && !stored.text.includes("Download all"));
  const notStored = render(notStoredPartly);
  check("not stored: warn tone, “Converted, but not stored”, rejected file still listed", notStored.noticeTone === "warn" && notStored.text.includes("Converted, but not stored") && notStored.text.includes("1 file was converted, but the output could not be stored. It cannot be downloaded") && notStored.text.includes("Rejected files"));
  check("not stored: nothing is offered for download", offersNothingStored(notStored));
}

section("a later run does not change what an earlier run stored");
{
  const earlier = itemsOf(responseOf([converted("earlier.png", RESULT_ID_A, ARTIFACT_A)], true));
  const view = render(responseOf([converted("later.png", RESULT_ID_B, null)], false), itemsOf(responseOf([converted("later.png", RESULT_ID_B, null)], false), earlier));
  check("the banner describes the latest run: not stored", view.noticeTone === "warn" && view.text.includes("Converted, but not stored"));
  check("the earlier, stored file keeps its download", view.hrefs.some((href) => href.startsWith(`/api/v1/artifacts/${ARTIFACT_A}`)));
  check("the later, unstored file has none", view.hrefs.filter((href) => href.startsWith("/api/v1/artifacts/")).every((href) => href.includes(ARTIFACT_A)) && view.text.includes("Not stored, so there is no file to download."));
  check("no History link is shown for the unstored run", !view.html.includes("/app/history"));

  const reverse = render(responseOf([converted("later.png", RESULT_ID_B, ARTIFACT_B)], true), itemsOf(responseOf([converted("later.png", RESULT_ID_B, ARTIFACT_B)], true), itemsOf(responseOf([converted("earlier.png", RESULT_ID_A, null)], false))));
  check("an earlier, unstored file gets no download when a later run is stored", reverse.noticeTone === "ok" && reverse.hrefs.filter((href) => href.startsWith("/api/v1/artifacts/")).every((href) => href.includes(ARTIFACT_B)) && reverse.text.includes("Not stored, so there is no file to download.") && !reverse.text.includes("Download all"));
}

/* ------------------------------------------------- 3. the other tools' notice */
section("storage notice used by the CSS, asset and audit tools");
{
  const notice = (props) => renderToStaticMarkup(createElement(StorageNotice, { title: "Patched, but not stored", ...props }, "The patched CSS is complete."));
  check("renders nothing when the result was stored", notice({ persisted: true, storage: { persisted: true } }) === "" && notice({ persisted: true, storage: undefined }) === "");
  const failed = notice({ persisted: false, storage: FAILURE });
  check("not stored: warn notice with the server's reason, hint and category", failed.includes('data-tone="warn"') && failed.includes("Patched, but not stored") && failed.includes(`Reason: ${FAILURE.message}`) && failed.includes(FAILURE.hint) && failed.includes(FAILURE.category));
  const unexplained = notice({ persisted: false, storage: undefined });
  check("not stored without a reason: still shown, with generic wording", unexplained.includes('data-tone="warn"') && unexplained.includes("Reason: Storage is unavailable."));
  check("a contradictory response is shown as not stored", notice({ persisted: true, storage: FAILURE }).includes('data-tone="warn"'));
}

const ok = report();
if (ok) console.log("\nAll outcome checks passed.");
process.exit(ok ? 0 : 1);
