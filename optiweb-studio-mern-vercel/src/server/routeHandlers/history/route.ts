import { jsonOk, route, searchParams } from "@/server/http/handler";
import { clearSessionHistory, listHistory, sessionSummary } from "@/server/services/storageService";
import { historyQuerySchema } from "@/server/validators";


/** GET /api/v1/history — session-scoped, filterable, paginated. */
export const GET = route(
  async (req, ctx) => {
    const params = searchParams(req);
    const query = historyQuerySchema.parse({
      q: params.get("q") ?? undefined,
      kind: params.get("kind") ?? "all",
      status: params.get("status") ?? "all",
      sort: params.get("sort") ?? "newest",
      page: params.get("page") ?? 1,
      pageSize: params.get("pageSize") ?? 10,
    });

    const [page, summary] = await Promise.all([listHistory(ctx.sessionId, query), sessionSummary(ctx.sessionId)]);
    return jsonOk({ ...page, summary }, ctx);
  },
  { bucket: "history" },
);

/** DELETE /api/v1/history — clears every record and artifact for this session. */
export const DELETE = route(async (_req, ctx) => {
  const removed = await clearSessionHistory(ctx.sessionId);
  return jsonOk({ removed }, ctx);
}, { bucket: "history" });
