/** Request validation. The API accepts one request body: an audit request. */
import { z } from "zod";

export const auditRequestSchema = z.object({
  url: z.string().min(8).max(2048),
  // Pages in addition to the requested one. The service applies the configured page limit.
  extraPages: z.number().int().min(0).max(2).default(0),
});

export type AuditRequest = z.infer<typeof auditRequestSchema>;
