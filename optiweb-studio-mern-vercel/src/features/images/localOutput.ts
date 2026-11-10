/**
 * Converted files held in this browser tab.
 *
 * When a result could not be stored, the API sends the converted file inside
 * the response. This module turns that payload into a Blob with an object URL,
 * so the file can be previewed and saved without a server-side copy. The copy
 * lives only as long as the tab keeps the URL.
 */
import type { InlineOutput } from "@/types/domain";

export type LocalOutput = {
  /** `blob:` URL of the file. Release it with `releaseLocalOutput`. */
  url: string;
  /** Name the file is saved under. */
  filename: string;
  bytes: number;
  blob: Blob;
};

/** Formats the image pipeline produces. Anything else is saved as plain bytes and never rendered. */
const RENDERABLE = new Set(["image/webp", "image/avif", "image/jpeg", "image/png", "image/gif", "image/tiff"]);

export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Decodes the payload and gives it an object URL. Returns null when the
 * payload cannot be decoded or is not as long as it claims, so a damaged file
 * is never offered for download.
 */
export function createLocalOutput(inline: InlineOutput, filename: string): LocalOutput | null {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToBytes(inline.data);
  } catch {
    return null;
  }
  if (bytes.byteLength !== inline.bytes) return null;
  const type = RENDERABLE.has(inline.contentType) ? inline.contentType : "application/octet-stream";
  const blob = new Blob([bytes], { type });
  return { url: URL.createObjectURL(blob), filename, bytes: bytes.byteLength, blob };
}

export function releaseLocalOutput(output: LocalOutput | null | undefined): void {
  if (output) URL.revokeObjectURL(output.url);
}

/** `name.ext`, `name-2.ext`, `name-3.ext`, … so two files with the same name both fit in one ZIP. */
function uniqueName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let copy = 2; used.has(candidate.toLowerCase()); copy += 1) candidate = `${base}-${copy}${extension}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Bundles files held in this tab into one ZIP. The entries are stored without
 * compression, because the images are already compressed. The ZIP library is
 * loaded on first use.
 */
export async function zipLocalOutputs(outputs: readonly LocalOutput[]): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const used = new Set<string>();
  for (const output of outputs) {
    zip.file(uniqueName(output.filename, used), new Uint8Array(await output.blob.arrayBuffer()), { binary: true });
  }
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
  return new Blob([new Uint8Array(bytes)], { type: "application/zip" });
}
