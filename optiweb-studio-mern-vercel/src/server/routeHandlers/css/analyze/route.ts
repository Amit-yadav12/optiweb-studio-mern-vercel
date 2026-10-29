import { jsonOk, parseJson, route } from "@/server/http/handler";
import { analyzeCss, POLICY_NOTES } from "@/server/services/cssService";
import { cssAnalyzeSchema } from "@/server/validators";


/** POST /api/v1/css/analyze — read-only diagnosis, never mutates the input. */
export const POST = route(async (req, ctx) => {
  const { css } = await parseJson(req, cssAnalyzeSchema);
  const analysis = analyzeCss(css, "swap");
  return jsonOk(
    {
      fontFaceCount: analysis.fontFaceCount,
      withFontDisplay: analysis.withFontDisplay,
      missingFontDisplay: analysis.missingFontDisplay,
      malformed: analysis.malformed,
      findings: analysis.findings,
      parseErrors: analysis.parseErrors,
      policy: analysis.policy,
      policies: POLICY_NOTES,
    },
    ctx,
  );
}, { bucket: "css/analyze" });
