/**
 * Saving files that exist only in this tab.
 *
 * A result is a Blob in the page's memory. It is saved by pointing a link at
 * a `blob:` URL, which the browser resolves locally: no request leaves the
 * device. Several results are bundled into a ZIP the same way, in the tab.
 */

/** Saves a Blob under a file name. The temporary `blob:` URL is released right after the click. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // The click is handled synchronously for blob: URLs. Releasing on the next
  // turn is safe, and keeps the URL from living as long as the tab.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** `name.ext`, `name-2.ext`, `name-3.ext`, … so two files with the same name both fit in one ZIP. */
export function uniqueName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let copy = 2; used.has(candidate.toLowerCase()); copy += 1) candidate = `${base}-${copy}${extension}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Bundles files into one ZIP, in this tab. Entries are stored without
 * compression, because images are already compressed. The ZIP library is
 * loaded on first use.
 */
export async function zipFiles(files: ReadonlyArray<{ name: string; blob: Blob }>): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const used = new Set<string>();
  for (const file of files) zip.file(uniqueName(file.name, used), file.blob, { binary: true });
  return zip.generateAsync({ type: "blob", compression: "STORE", mimeType: "application/zip" });
}
