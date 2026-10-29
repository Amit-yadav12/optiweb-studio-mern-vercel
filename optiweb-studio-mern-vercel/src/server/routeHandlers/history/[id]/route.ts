import { jsonOk, routeWithParams } from "@/server/http/handler";
import { notFound } from "@/server/http/errors";
import { deleteJob, getJobDetail } from "@/server/services/storageService";


/** GET /api/v1/history/:id — job header plus per-file rows (metadata only). */
export const GET = routeWithParams<{ id: string }>(async (_req, ctx, { id }) => {
  const detail = await getJobDetail(ctx.sessionId, id);
  if (!detail) throw notFound("That job is not in this session's history.");
  return jsonOk(
    {
      job: {
        id: detail.job.id,
        kind: detail.job.kind,
        status: detail.job.status,
        label: detail.job.label,
        fileCount: detail.job.fileCount,
        inputBytes: Number(detail.job.inputBytes),
        outputBytes: Number(detail.job.outputBytes),
        savedBytes: Number(detail.job.savedBytes),
        note: detail.job.note,
        createdAt: detail.job.createdAt.toISOString(),
      },
      items: detail.items.map((item) => ({
        id: item.id,
        filename: item.filename,
        outputFilename: item.outputFilename,
        status: item.status,
        inputBytes: Number(item.inputBytes),
        outputBytes: Number(item.outputBytes),
        savedBytes: Number(item.savedBytes),
        savingsPercent: item.savingsPercent,
        inputWidth: item.inputWidth,
        inputHeight: item.inputHeight,
        outputWidth: item.outputWidth,
        outputHeight: item.outputHeight,
        outputFormat: item.outputFormat,
        message: item.message,
        hasArtifact: Boolean(item.artifactId),
      })),
    },
    ctx,
  );
}, { bucket: "history" });

/** DELETE /api/v1/history/:id */
export const DELETE = routeWithParams<{ id: string }>(async (_req, ctx, { id }) => {
  const removed = await deleteJob(ctx.sessionId, id);
  if (!removed) throw notFound("That job is not in this session's history.");
  return jsonOk({ deleted: id }, ctx);
}, { bucket: "history" });
