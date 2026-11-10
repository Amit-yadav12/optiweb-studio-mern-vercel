import { jsonOk, parseJson, route } from "../../../http/handler.js";
import { analyzeCss, POLICY_NOTES } from "../../../services/cssService.js";
import { cssAnalyzeSchema } from "../../../validators/index.js";


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
