import { jsonOk, parseJson, route } from "@/server/http/handler";
import { patchFontDisplay } from "@/server/services/cssService";
import { persistJob } from "@/server/services/storageService";
import { cssPatchSchema } from "@/server/validators";


/** POST /api/v1/css/patch-font-display — parses, patches, reports exact deltas. */
export const POST = route(async (req, ctx) => {
  const { css, policy } = await parseJson(req, cssPatchSchema);
  const patched = patchFontDisplay(css, policy);

  const stored = await persistJob({
    sessionId: ctx.sessionId,
    kind: "css.font-display",
    status: patched.analysis.parseErrors.length > 0 ? "failed" : "completed",
    label: `${patched.rulesPatched.length} @font-face rule${patched.rulesPatched.length === 1 ? "" : "s"} → font-display: ${policy}`,
    fileCount: 1,
    inputBytes: patched.inputBytes,
    outputBytes: patched.outputBytes,
    savedBytes: 0,
    note: `${patched.analysis.fontFaceCount} @font-face found · policy ${policy}`,
    items: [
      {
        filename: "styles.font-display.css",
        status: patched.analysis.parseErrors.length > 0 ? "failed" : "completed",
        inputBytes: patched.inputBytes,
        outputBytes: patched.outputBytes,
        savedBytes: 0,
        savingsPercent: null,
        outputFormat: "css",
        message: patched.analysis.parseErrors[0]?.reason,
        artifact: {
          filename: "styles.font-display.css",
          contentType: "text/css; charset=utf-8",
          data: Buffer.from(patched.output, "utf8"),
          kind: "css",
        },
      },
    ],
  });

  // Replace the placeholder artifact id with the persisted one (if any).
  const [artifactId] = Array.from(stored.artifacts.keys());
  return jsonOk({ ...patched, jobId: stored.jobId ?? "", artifactId: artifactId ?? null, persisted: stored.persisted }, ctx);
}, { bucket: "css/analyze" });
