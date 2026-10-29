import { jsonOk, parseJson, route } from "@/server/http/handler";
import { auditRequestSchema } from "@/server/validators";
import { runWebsiteAudit } from "@/server/services/auditService";
import { persistJob } from "@/server/services/storageService";


/** POST /api/v1/audits — SSRF-safe document fetch + asset discovery. */
export const POST = route(async (req, ctx) => {
  const { url } = await parseJson(req, auditRequestSchema);
  const report = await runWebsiteAudit(url);

  const stored = await persistJob({
    sessionId: ctx.sessionId,
    kind: "site.audit",
    status: "completed",
    label: `Audit ${new URL(report.fetchedUrl).hostname}`,
    fileCount: report.resources.length,
    inputBytes: report.totals.transferredBytes,
    outputBytes: 0,
    savedBytes: 0,
    note: `${report.totals.requestsOk}/${report.totals.requestsAttempted} resources · ${report.findings.length} findings`,
    items: [
      {
        filename: "audit-report.json",
        status: "completed",
        inputBytes: report.totals.transferredBytes,
        outputBytes: Buffer.byteLength(JSON.stringify(report)),
        savedBytes: 0,
        savingsPercent: null,
        outputFormat: "json",
        artifact: {
          filename: "audit-report.json",
          contentType: "application/json; charset=utf-8",
          data: Buffer.from(JSON.stringify(report), "utf8"),
          kind: "json",
        },
      },
    ],
  });

  const [artifactId] = Array.from(stored.artifacts.keys());
  return jsonOk({ ...report, jobId: stored.jobId ?? "", artifactId: artifactId ?? null, persisted: stored.persisted }, ctx);
}, { bucket: "audits" });
