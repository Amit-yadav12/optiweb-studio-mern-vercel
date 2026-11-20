/**
 * Checks a selected file before any pixel is decoded.
 *
 * The decision uses the file's own bytes: its signature decides the format,
 * and its header gives the dimensions. The file's name and the type the
 * browser reported for it are not trusted. A file is refused here when
 * decoding it would be unsafe (too many pixels), pointless (a vector) or lossy
 * in a way the user did not ask for (an animation reduced to one frame).
 */
import { displayedSize, readImageHeader, type ImageFormat } from "@/shared/imageHeader";
import type { EngineLimits } from "./plan";
import type { Inspection } from "./types";

/** How much of a file is read to find its header. Camera files put large metadata blocks before the dimensions. */
export const HEAD_BYTES = 1024 * 1024;
/** A GIF states its frame count nowhere: the frames have to be walked. This is the most of a GIF that is read for that. */
const GIF_SCAN_BYTES = 64 * 1024 * 1024;

const FORMAT_NAME: Record<ImageFormat, string> = {
  jpeg: "JPEG",
  png: "PNG",
  gif: "GIF",
  webp: "WebP",
  avif: "AVIF",
  heic: "HEIC",
  tiff: "TIFF",
  bmp: "BMP",
  ico: "ICO",
  svg: "SVG",
};

const EXTENSIONS: Record<string, ImageFormat> = {
  jpg: "jpeg",
  jpeg: "jpeg",
  jfif: "jpeg",
  png: "png",
  apng: "png",
  gif: "gif",
  webp: "webp",
  avif: "avif",
  heic: "heic",
  heif: "heic",
  tif: "tiff",
  tiff: "tiff",
  bmp: "bmp",
  ico: "ico",
  svg: "svg",
};

export function formatName(format: ImageFormat): string {
  return FORMAT_NAME[format];
}

/** The format a file name's extension suggests, or null. */
export function formatFromName(name: string): ImageFormat | null {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? (EXTENSIONS[match[1].toLowerCase()] ?? null) : null;
}

async function readSlice(file: Blob, bytes: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, bytes).arrayBuffer());
}

export async function inspectFile(file: Blob, name: string, limits: Pick<EngineLimits, "maxSourcePixels">): Promise<Inspection> {
  if (file.size === 0) {
    return { ok: false, code: "empty", message: "The file is empty.", hint: "Export the image again and select the new file." };
  }

  let head: Uint8Array;
  try {
    head = await readSlice(file, HEAD_BYTES);
  } catch {
    return {
      ok: false,
      code: "unreadable",
      message: "The browser could not read this file.",
      hint: "The file may have been moved, renamed or deleted after it was selected. Select it again.",
    };
  }

  let header = readImageHeader(head);
  if (header === null) {
    return {
      ok: false,
      code: "not_an_image",
      message: "The contents of this file are not an image format the tool reads.",
      hint: "The check reads the file's first bytes, not its name. Supported: JPEG, PNG, WebP, AVIF, GIF, BMP, and TIFF or HEIC where the browser can decode them.",
    };
  }

  // A GIF has to be walked to count its frames. When the first megabyte holds
  // only one, read on, so that a long animation is not mistaken for a still.
  if (header.format === "gif" && !header.animated && file.size > head.byteLength) {
    try {
      header = readImageHeader(await readSlice(file, GIF_SCAN_BYTES)) ?? header;
    } catch {
      /* The first megabyte's answer stands. */
    }
    if (!header.animated && file.size > GIF_SCAN_BYTES) {
      return {
        ok: false,
        code: "animated",
        message: "This GIF is too large to check for animation.",
        hint: "Converting an animation would keep only its first frame, so a GIF that cannot be checked is not converted.",
      };
    }
  }

  const label = FORMAT_NAME[header.format];
  if (header.format === "svg") {
    return {
      ok: false,
      code: "vector",
      message: "This is an SVG, a vector image. Turning it into pixels would usually make it larger.",
      hint: "Serve the SVG as it is, minified and compressed. Select a raster image to optimize.",
    };
  }
  if (header.malformed) {
    return {
      ok: false,
      code: "damaged",
      message: `The file starts like a ${label}, but ${header.malformed}.`,
      hint: "The file is probably incomplete or damaged. Export it again from the source.",
    };
  }
  if (header.animated) {
    const frames = header.frames ? `${header.frames} frames` : "several frames";
    return {
      ok: false,
      code: "animated",
      message: `This ${label} is animated (${frames}). A browser can write only still images, so converting it would keep the first frame and drop the rest.`,
      hint: "For animation, a video (MP4 or WebM) is normally far smaller. To convert a single frame, export that frame as a still image first.",
    };
  }

  const shown = displayedSize(header);
  const width = shown.width as number;
  const height = shown.height as number;
  const pixels = width * height;
  if (pixels > limits.maxSourcePixels) {
    const megapixels = (value: number) => (value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1);
    return {
      ok: false,
      code: "too_many_pixels",
      message: `This image is ${width.toLocaleString("en-US")} × ${height.toLocaleString("en-US")} px (${megapixels(pixels)} MP). Decoding it needs about ${Math.round((pixels * 4) / (1024 * 1024)).toLocaleString("en-US")} MB of memory, more than this tab can safely use on this device. The limit here is ${megapixels(limits.maxSourcePixels)} MP.`,
      hint: "Scale the image down in an image editor first. The limit is checked from the file's header, before anything is decoded.",
    };
  }

  const named = formatFromName(name);
  return {
    ok: true,
    source: {
      format: header.format,
      mime: header.mime,
      width,
      height,
      orientation: header.orientation,
      mayHaveAlpha: header.hasAlpha !== false,
      metadata: header.metadata,
      traits: header.traits,
      nameMismatch: named !== null && named !== header.format ? `The name ends in .${name.split(".").pop()}, but the file is a ${label}.` : null,
    },
  };
}
