import { jsonOk, route } from "@/server/http/handler";
import { readMultipart } from "@/server/http/multipart";
import { analyzeAssets } from "@/server/services/assetService";
import { persistJob } from "@/server/services/storageService";
import { badRequest } from "@/server/http/errors";


/** POST /api/v1/assets/analyze — diagnostics for the exact files you upload. */
export const POST = route(async (req, ctx) => {
  const { files, fields } = await readMultipart(req, { kind: "asset" });

  const thresholdKbRaw = Number(fields.thresholdKb);
  const thresholdKb = Number.isFinite(thresholdKbRaw) && thresholdKbRaw >= 50 ? Math.min(thresholdKbRaw, 10_000) : 300;

  const analysis = await analyzeAssets(
    files.map((file) => ({ filename: file.filename, contentType: file.contentType, buffer: file.buffer })),
    { thresholdKb },
  );

  const totalInput = files.reduce((sum, file) => sum + file.buffer.byteLength, 0);
  const stored = await persistJob({
    sessionId: ctx.sessionId,
    kind: "asset.analyze",
    status: "completed",
    label: `${analysis.files.length} asset${analysis.files.length === 1 ? "" : "s"} inspected`,
    fileCount: analysis.files.length,
    inputBytes: totalInput,
    outputBytes: 0,
    savedBytes: 0,
    note: `${analysis.summary.findings} finding${analysis.summary.findings === 1 ? "" : "s"} · ${thresholdKb} KB threshold`,
    items: analysis.files.map((file) => ({
      filename: file.filename,
      status: file.error ? "failed" : "completed",
      inputBytes: file.bytes,
      outputBytes: 0,
      savedBytes: 0,
      savingsPercent: null,
      inputWidth: file.width,
      inputHeight: file.height,
      outputFormat: file.format,
      message: file.error ?? `${file.findings.length} finding(s)`,
      artifact: null,
    })),
  });

  if (!analysis.files.length) throw badRequest("No analyzable files were received.");
  return jsonOk({ ...analysis, jobId: stored.jobId ?? "", persisted: stored.persisted }, ctx);
}, { bucket: "assets/analyze" });
