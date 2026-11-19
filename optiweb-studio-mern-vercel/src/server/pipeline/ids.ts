import { createHash } from "node:crypto";

/**
 * A UUID that is a pure function of its inputs. Used where the same logical
 * record must get the same ID every time it is written, so that a retried
 * operation updates the record instead of creating a second one.
 */
export function stableUuid(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
