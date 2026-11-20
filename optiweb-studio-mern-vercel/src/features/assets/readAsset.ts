/**
 * Reads what the asset analysis needs from a file the user selected: the
 * start of the file for its header, and the whole text of a stylesheet.
 * Nothing here leaves the tab.
 */
import { HEAD_BYTES } from "@/features/images/engine/inspect";
import type { AssetInput } from "@/shared/assets";
import { MAX_CSS_CHARS } from "@/shared/css";
import { sniffFormat } from "@/shared/imageHeader";

/** A GIF states its frame count nowhere, so its frames are walked. This is the most of one that is read. */
const GIF_SCAN_BYTES = 64 * 1024 * 1024;

export async function readAsset(file: File): Promise<AssetInput> {
  let head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  if (file.size > head.byteLength && sniffFormat(head) === "gif") {
    head = new Uint8Array(await file.slice(0, GIF_SCAN_BYTES).arrayBuffer());
  }
  let text: string | null | undefined;
  if (/\.css$/i.test(file.name)) {
    // One character is at least one byte, so a file this large cannot fit the parser's limit.
    text = file.size > MAX_CSS_CHARS * 4 ? null : await file.text();
    if (text !== null && text.length > MAX_CSS_CHARS) text = null;
  }
  return { filename: file.name, bytes: file.size, head, text };
}
