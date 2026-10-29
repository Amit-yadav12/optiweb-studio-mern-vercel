import { jsonOk, route } from "@/server/http/handler";


/**
 * GET /api/v1/session — resolves (and issues) the guest session used to scope
 * history and artifacts. Returning the id lets the UI show which session a
 * history table belongs to, without exposing any account concept.
 */
export const GET = route(async (_req, ctx) => {
  const issued = ctx.sessionIssued;
  const shortCode = `${ctx.sessionId.slice(0, 4)}…${ctx.sessionId.slice(-4)}`;
  return jsonOk({ sessionId: ctx.sessionId, shortCode, issued, mode: "guest" }, ctx);
});
