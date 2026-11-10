/**
 * Output files that travel inside a response.
 *
 * A converted file normally becomes a stored artifact with a download URL.
 * When storage fails there is no artifact, so the file is sent in the JSON
 * response instead and the browser saves it directly.
 */
import { limits } from "../config/env.js";
import type { InlineOutput } from "../../types/domain.js";

/**
 * Decides which files are sent. `sizes` are the output sizes in bytes, in
 * response order; 0 marks a file with no output.
 *
 * Files are accepted in order while their combined size stays within `budget`.
 * A file that does not fit is skipped, and a later, smaller file can still be
 * accepted.
 */
export function planInlineOutputs(sizes: readonly number[], budget: number = limits.maxInlineBytes): boolean[] {
  let remaining = budget;
  return sizes.map((size) => {
    if (size <= 0 || size > remaining) return false;
    remaining -= size;
    return true;
  });
}

export function toInlineOutput(data: Buffer, contentType: string): InlineOutput {
  return { encoding: "base64", contentType, bytes: data.byteLength, data: data.toString("base64") };
}
