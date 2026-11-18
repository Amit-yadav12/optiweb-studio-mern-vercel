/**
 * File signatures of the raster formats the image pipeline accepts.
 *
 * This is the first content check after an upload: it needs only the first
 * bytes of the object, so a file that is not an image at all is rejected and
 * deleted before a job is queued. It is not the last check. The worker decodes
 * every file with the real image library, which is what decides whether the
 * file is a valid image and how large it is once decoded.
 */
export type RasterSignature = "jpeg" | "png" | "gif" | "webp" | "avif" | "tiff";

/** Bytes needed to recognise every supported signature. */
export const SIGNATURE_BYTES = 32;

export function sniffSignature(head: Uint8Array): RasterSignature | null {
  const at = (offset: number, ...bytes: number[]): boolean => bytes.every((byte, index) => head[offset + index] === byte);
  const ascii = (offset: number, text: string): boolean => at(offset, ...Array.from(text, (char) => char.charCodeAt(0)));
  if (head.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (head.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (head.length >= 6 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) return "gif";
  if (head.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  if (head.length >= 4 && (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a))) return "tiff";
  // ISO base media file: a box size, then "ftyp" and a brand. AVIF uses the brands avif (still) and avis (sequence).
  if (head.length >= 12 && ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis"))) return "avif";
  return null;
}

const TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const RASTER_TYPES = new Set(Object.values(TYPE_BY_EXTENSION));

/**
 * The content type an upload is authorized for: the declared type when it is
 * a supported raster type, otherwise the type implied by the file extension.
 * Null when neither names a supported format.
 */
export function rasterContentType(filename: string, declared: string): string | null {
  const type = declared.trim().toLowerCase().split(";")[0];
  if (RASTER_TYPES.has(type)) return type;
  const extension = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase() ?? "";
  return TYPE_BY_EXTENSION[extension] ?? null;
}
