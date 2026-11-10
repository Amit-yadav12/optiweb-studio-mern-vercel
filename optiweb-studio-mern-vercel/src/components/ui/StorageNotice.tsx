import type { ReactNode } from "react";
import { Notice } from "@/components/ui/Feedback";
import type { StorageOutcome } from "@/types/domain";

/**
 * Says that a tool finished its work but the result was not stored.
 *
 * It renders nothing when the result was stored. The reason, the hint and the
 * reference come from the server's fixed list of storage failures, so the
 * notice names the actual cause instead of guessing one.
 */
export function StorageNotice({
  storage,
  persisted,
  title,
  children,
}: {
  /** The `storage` object of the API response. */
  storage: StorageOutcome | undefined;
  /** The `persisted` flag of the same response. */
  persisted: boolean;
  title: string;
  /** What this means for the result on screen. */
  children: ReactNode;
}) {
  if (persisted && storage?.persisted !== false) return null;
  const failure = storage && storage.persisted === false ? storage : null;
  return (
    <Notice tone="warn" title={title} hint={failure?.hint} code={failure?.category}>
      <p>{children}</p>
      <p className="mt-1">Reason: {failure?.message ?? "Storage is unavailable."}</p>
    </Notice>
  );
}
