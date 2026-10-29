/**
 * Status tone mapping shared by server and client components.
 * Kept out of the client Feedback module so server components can use it too.
 */
export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

export function statusToneFor(status: string): Tone {
  if (status === "completed" || status === "ok") return "ok";
  if (status === "partial" || status === "warning") return "warn";
  if (status === "failed" || status === "issue") return "danger";
  if (status === "processing" || status === "info") return "accent";
  return "neutral";
}
