/**
 * Decode → resize → encode, for one image.
 *
 * This is the whole of the image processing. It runs inside the page's own
 * Web Worker (or on the page itself in a browser without worker canvases) and
 * uses only the browser's decoder, a canvas, the browser's encoders and two
 * WebAssembly codecs that are served with the app. It makes no network request
 * with the image: the only requests it can cause are the downloads of the
 * codec files themselves.
 */
import { FORMAT_LABEL, OUTPUT_MIME, targetSize } from "./plan";
import type { CandidateOutcome, JobFailureCode, JobRequest, JobResult, JobStage, OutputFormat } from "./types";

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type AnyContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export type Decoded = { image: CanvasImageSource; width: number; height: number; release(): void };

/** The few things that differ between a worker and a page. */
export type Backend = {
  createCanvas(width: number, height: number): AnyCanvas;
  toBlob(canvas: AnyCanvas, type: string, quality?: number): Promise<Blob | null>;
  decode(blob: Blob): Promise<Decoded>;
};

export type Hooks = {
  stage(stage: JobStage, detail?: string): void;
  /** True once the caller no longer wants the result. Checked between steps. */
  cancelled(): boolean;
};

export class JobError extends Error {
  constructor(
    readonly code: JobFailureCode,
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "JobError";
  }
}

/* --------------------------------- backends -------------------------------- */

/** For a Web Worker: OffscreenCanvas and createImageBitmap. */
export function offscreenBackend(): Backend {
  return {
    createCanvas: (width, height) => new OffscreenCanvas(width, height),
    toBlob: (canvas, type, quality) => (canvas as OffscreenCanvas).convertToBlob({ type, quality }),
    decode: async (blob) => {
      const bitmap = await createImageBitmap(blob);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    },
  };
}

/** For the page itself, in a browser that has no canvas in workers. */
export function documentBackend(): Backend {
  return {
    createCanvas: (width, height) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    toBlob: (canvas, type, quality) => new Promise((resolve) => (canvas as HTMLCanvasElement).toBlob(resolve, type, quality)),
    decode: async (blob) => {
      if (typeof createImageBitmap === "function") {
        const bitmap = await createImageBitmap(blob);
        return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
      }
      const url = URL.createObjectURL(blob);
      try {
        const element = new Image();
        element.decoding = "async";
        element.src = url;
        await element.decode();
        return { image: element, width: element.naturalWidth, height: element.naturalHeight, release: () => undefined };
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  };
}

/* ------------------------------ canvas helpers ----------------------------- */

function context(canvas: AnyCanvas): AnyContext {
  const ctx = canvas.getContext("2d") as AnyContext | null;
  if (!ctx) {
    throw new JobError("canvas_unavailable", "This browser could not create a drawing surface for the image.", "Close other tabs to free memory, then try again.");
  }
  return ctx;
}

/** Gives a canvas's memory back at once. Some browsers keep it until the canvas is collected otherwise. */
function discard(canvas: AnyCanvas | null): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * True when the canvas really holds pixels at this size. Past a browser's
 * canvas limit, a canvas is created without error but stays blank; one pixel
 * written to the far corner and read back shows the difference.
 */
function canvasIsUsable(ctx: AnyContext, width: number, height: number): boolean {
  try {
    ctx.fillStyle = "#000";
    ctx.fillRect(width - 1, height - 1, 1, 1);
    const alpha = ctx.getImageData(width - 1, height - 1, 1, 1).data[3];
    ctx.clearRect(width - 1, height - 1, 1, 1);
    return alpha === 255;
  } catch {
    return false;
  }
}

/**
 * The canvas transform that turns stored pixels into the displayed image for
 * an EXIF orientation. `width` and `height` are the stored (unrotated) size of
 * what is about to be drawn. Returns `[a, b, c, d, e, f]` for `setTransform`.
 */
export function orientationMatrix(orientation: number, width: number, height: number): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2:
      return [-1, 0, 0, 1, width, 0];
    case 3:
      return [-1, 0, 0, -1, width, height];
    case 4:
      return [1, 0, 0, -1, 0, height];
    case 5:
      return [0, 1, 1, 0, 0, 0];
    case 6:
      return [0, 1, -1, 0, height, 0];
    case 7:
      return [0, -1, -1, 0, height, width];
    case 8:
      return [0, -1, 1, 0, 0, width];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

/** A 2 × 1 JPEG whose EXIF orientation says "rotate a quarter turn". Decoders that apply EXIF report it as 1 × 2. */
const ORIENTATION_PROBE =
  "/9j/4QC8RXhpZgAASUkqAAgAAAAGABIBAwABAAAABgAAABoBBQABAAAAVgAAABsBBQABAAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA6AMAADhjAADoAwAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAAAIAAAADoAQAAQAAAAEAAAAAAAAA/9sAQwAQCwwODAoQDg0OEhEQExgoGhgWFhgxIyUdKDozPTw5Mzg3QEhcTkBEV0U3OFBtUVdfYmdoZz5NcXlwZHhcZWdj/9sAQwEREhIYFRgvGhovY0I4QmNjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj/8AAEQgAAQACAwEiAAIRAQMRAf/EABQAAQAAAAAAAAAAAAAAAAAAAAD/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AAAP/9k=";

let decoderAppliesOrientation: Promise<boolean> | null = null;

/** Whether this browser's decoder rotates a photo according to its EXIF orientation. Asked once per worker. */
function decoderOrients(backend: Backend): Promise<boolean> {
  decoderAppliesOrientation ??= (async () => {
    try {
      const binary = atob(ORIENTATION_PROBE);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const decoded = await backend.decode(new Blob([bytes], { type: "image/jpeg" }));
      const applied = decoded.width === 1 && decoded.height === 2;
      decoded.release();
      return applied;
    } catch {
      // Without an answer, assume the modern behaviour: every current browser applies it.
      return true;
    }
  })();
  return decoderAppliesOrientation;
}

/**
 * Draws the decoded image at the output size.
 *
 * Large reductions are done in halving steps before the final draw. A single
 * draw samples only a few source pixels per output pixel, which leaves jagged
 * edges and moiré when an image is reduced to less than half its size.
 */
function render(backend: Backend, decoded: Decoded, orientation: number, outputWidth: number, outputHeight: number): { canvas: AnyCanvas; ctx: AnyContext } {
  const quarterTurn = orientation >= 5;
  // Size of the drawn image in stored (unrotated) coordinates.
  const storedWidth = quarterTurn ? outputHeight : outputWidth;
  const storedHeight = quarterTurn ? outputWidth : outputHeight;

  let current: CanvasImageSource = decoded.image;
  let currentWidth = decoded.width;
  let currentHeight = decoded.height;
  let scratch: AnyCanvas | null = null;
  while (currentWidth >= storedWidth * 2 && currentHeight >= storedHeight * 2) {
    const nextWidth = Math.max(storedWidth, Math.ceil(currentWidth / 2));
    const nextHeight = Math.max(storedHeight, Math.ceil(currentHeight / 2));
    const next = backend.createCanvas(nextWidth, nextHeight);
    const nextCtx = context(next);
    nextCtx.imageSmoothingEnabled = true;
    nextCtx.imageSmoothingQuality = "high";
    nextCtx.drawImage(current, 0, 0, currentWidth, currentHeight, 0, 0, nextWidth, nextHeight);
    discard(scratch);
    scratch = next;
    current = next;
    currentWidth = nextWidth;
    currentHeight = nextHeight;
  }

  const canvas = backend.createCanvas(outputWidth, outputHeight);
  const ctx = context(canvas);
  if (!canvasIsUsable(ctx, outputWidth, outputHeight)) {
    discard(scratch);
    discard(canvas);
    throw new JobError(
      "canvas_too_large",
      `This browser cannot hold a ${outputWidth.toLocaleString("en-US")} × ${outputHeight.toLocaleString("en-US")} px image in memory.`,
      "Set a maximum width so the output is smaller, or close other tabs to free memory.",
    );
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (orientation > 1) ctx.setTransform(...orientationMatrix(orientation, storedWidth, storedHeight));
  ctx.drawImage(current, 0, 0, currentWidth, currentHeight, 0, 0, storedWidth, storedHeight);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  discard(scratch);
  return { canvas, ctx };
}

/** True when any pixel is not fully opaque. Reads the canvas in strips, and stops at the first such pixel. */
function usesTransparency(ctx: AnyContext, width: number, height: number): boolean {
  const strip = Math.max(1, Math.floor(1_000_000 / width));
  for (let y = 0; y < height; y += strip) {
    const data = ctx.getImageData(0, y, width, Math.min(strip, height - y)).data;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 255) return true;
    }
  }
  return false;
}

/* --------------------------------- encoders -------------------------------- */

const nativeSupport = new Map<string, Promise<boolean>>();

/**
 * Whether the browser's own canvas encoder writes this type. A browser that
 * does not know a type silently writes PNG instead, so the answer comes from
 * the type of a 1 × 1 test file, never from the request.
 */
function browserEncodes(backend: Backend, mime: string): Promise<boolean> {
  let known = nativeSupport.get(mime);
  if (!known) {
    known = (async () => {
      try {
        const canvas = backend.createCanvas(1, 1);
        context(canvas).fillRect(0, 0, 1, 1);
        const blob = await backend.toBlob(canvas, mime, 0.8);
        return blob !== null && blob.type === mime;
      } catch {
        return false;
      }
    })();
    nativeSupport.set(mime, known);
  }
  return known;
}

type AvifModule = { encode(data: Uint8Array, width: number, height: number, options: Record<string, unknown>): Uint8Array | null };
let avifCodec: Promise<{ module: AvifModule; defaults: Record<string, unknown> }> | null = null;

/**
 * The AVIF encoder (libavif compiled to WebAssembly, from the jSquash
 * project). No browser encodes AVIF from a canvas, so this codec does it. It
 * is downloaded from this site the first time AVIF is asked for, then cached
 * by the browser. The single-threaded build is used: the threaded one needs
 * cross-origin isolation headers that this app does not send.
 */
function loadAvif(): Promise<{ module: AvifModule; defaults: Record<string, unknown> }> {
  avifCodec ??= (async () => {
    const [{ default: factory }, meta] = await Promise.all([import("@jsquash/avif/codec/enc/avif_enc.js"), import("@jsquash/avif/meta.js")]);
    const module = (await factory({ noInitialRun: true })) as unknown as AvifModule;
    return { module, defaults: { ...meta.defaultOptions } };
  })();
  avifCodec.catch(() => {
    // A failed download must not be remembered: the next file tries again.
    avifCodec = null;
  });
  return avifCodec;
}

/** Encoder effort for AVIF, 0 (slowest) to 10 (fastest). 8 keeps a photo within seconds on one thread. */
const AVIF_SPEED = 8;

let webpCodec: Promise<(data: ImageData, options: { quality: number }) => Promise<ArrayBuffer>> | null = null;

/** libwebp compiled to WebAssembly. Used only in a browser whose canvas cannot write WebP (Safari). */
function loadWebp(): Promise<(data: ImageData, options: { quality: number }) => Promise<ArrayBuffer>> {
  webpCodec ??= import("@jsquash/webp/encode.js").then((module) => module.default as (data: ImageData, options: { quality: number }) => Promise<ArrayBuffer>);
  webpCodec.catch(() => {
    webpCodec = null;
  });
  return webpCodec;
}

function problemText(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return text ? `${fallback} (${text.slice(0, 160)})` : fallback;
}

/* ----------------------------------- job ----------------------------------- */

const DECODE_HINT: Partial<Record<JobRequest["source"]["format"], string>> = {
  tiff: "TIFF is decoded only by Safari. Open the file in an image editor and export it as PNG or JPEG first.",
  heic: "HEIC is decoded only by Safari. On an iPhone, share the photo as JPEG, or export it as JPEG from the Photos app.",
  avif: "This browser may be too old to decode AVIF. Update it, or export the image as PNG or JPEG first.",
  bmp: "The file may use a BMP variant the browser does not decode. Export it as PNG first.",
  ico: "The file may use an icon variant the browser does not decode. Export it as PNG first.",
};

export async function runJob(job: JobRequest, backend: Backend, hooks: Hooks): Promise<JobResult> {
  const stop = () => {
    if (hooks.cancelled()) throw new JobError("cancelled", "Cancelled.", "");
  };

  hooks.stage("decoding");
  const decodeStarted = performance.now();
  let decoded: Decoded;
  try {
    decoded = await backend.decode(job.file);
  } catch (error) {
    throw new JobError(
      "decode_failed",
      problemText(error, `This browser could not decode the ${job.source.format.toUpperCase()} file.`),
      DECODE_HINT[job.source.format] ?? "The file may be damaged, or larger than the browser can decode. Export it again from the source, or scale it down first.",
    );
  }
  const decodeMs = performance.now() - decodeStarted;

  let canvas: AnyCanvas | null = null;
  try {
    stop();
    // Orientation is applied here only when the decoder did not apply it.
    const orientation = job.source.orientation !== null && job.source.orientation > 1 && !(await decoderOrients(backend)) ? job.source.orientation : 1;
    const shownWidth = orientation >= 5 ? decoded.height : decoded.width;
    const shownHeight = orientation >= 5 ? decoded.width : decoded.height;
    if (shownWidth <= 0 || shownHeight <= 0) {
      throw new JobError("decode_failed", "The decoded image has no pixels.", "The file is probably damaged. Export it again from the source.");
    }
    const target = targetSize(shownWidth, shownHeight, job.maxWidth, job.maxHeight);

    hooks.stage(target.resized ? "resizing" : "encoding");
    const drawn = render(backend, decoded, orientation, target.width, target.height);
    canvas = drawn.canvas;
    const ctx = drawn.ctx;
    decoded.release();
    stop();

    const transparent = job.source.mayHaveAlpha ? usesTransparency(ctx, target.width, target.height) : null;
    let flattened = false;
    let pixels: ImageData | null = null;
    const imageData = () => (pixels ??= ctx.getImageData(0, 0, target.width, target.height));

    const encode = async (format: OutputFormat, quality: number): Promise<{ blob: Blob; encoder: "browser" | "wasm" }> => {
      const mime = OUTPUT_MIME[format];
      if (format === "jpeg" && transparent && !flattened) {
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, target.width, target.height);
        ctx.globalCompositeOperation = "source-over";
        flattened = true;
        pixels = null;
      }
      if (format !== "avif" && (await browserEncodes(backend, mime))) {
        const blob = await backend.toBlob(drawn.canvas, mime, format === "png" ? undefined : quality / 100);
        if (blob && blob.type === mime && blob.size > 0) return { blob, encoder: "browser" };
        throw new JobError("internal", `The browser's ${FORMAT_LABEL[format]} encoder returned no file.`, "");
      }
      if (format === "avif") {
        let codec: Awaited<ReturnType<typeof loadAvif>>;
        try {
          codec = await loadAvif();
        } catch (error) {
          throw new JobError("encoder_unavailable", problemText(error, "The AVIF encoder could not be loaded."), "It is a file served by this site. Check the connection and try again, or choose WebP.");
        }
        const data = imageData();
        const output = codec.module.encode(new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength), data.width, data.height, { ...codec.defaults, quality, speed: AVIF_SPEED });
        if (!output || output.byteLength === 0) throw new JobError("internal", "The AVIF encoder returned no file.", "");
        return { blob: new Blob([output.slice()], { type: mime }), encoder: "wasm" };
      }
      if (format === "webp") {
        let encodeWebp: Awaited<ReturnType<typeof loadWebp>>;
        try {
          encodeWebp = await loadWebp();
        } catch (error) {
          throw new JobError("encoder_unavailable", problemText(error, "The WebP encoder could not be loaded."), "This browser cannot write WebP itself, so a codec served by this site does it. Check the connection and try again, or choose JPEG.");
        }
        const output = await encodeWebp(imageData(), { quality });
        if (output.byteLength === 0) throw new JobError("internal", "The WebP encoder returned no file.", "");
        return { blob: new Blob([output], { type: mime }), encoder: "wasm" };
      }
      throw new JobError("encoder_unavailable", `This browser cannot write ${FORMAT_LABEL[format]} files.`, "Choose another output format.");
    };

    const outcomes: CandidateOutcome[] = job.candidates.map((plan) => ({ format: plan.format, quality: plan.quality, note: plan.note, blob: null, problem: null, encoder: null, ms: 0 }));
    // JPEG goes last: writing it fills transparent areas with white, which must not reach the other formats.
    const order = job.candidates.map((_, index) => index).sort((a, b) => Number(job.candidates[a].format === "jpeg") - Number(job.candidates[b].format === "jpeg"));

    for (const index of order) {
      stop();
      const plan = job.candidates[index];
      const outcome = outcomes[index];
      if (plan.requiresOpaque && transparent) {
        outcome.problem = "not tried: the image uses transparency, which JPEG cannot store";
        continue;
      }
      if (plan.format === "avif" && target.width * target.height > job.avifMaxPixels) {
        outcome.problem = `not tried: the output is above ${Math.round(job.avifMaxPixels / 1_000_000)} MP`;
        continue;
      }
      hooks.stage("encoding", FORMAT_LABEL[plan.format]);
      const started = performance.now();
      try {
        const encoded = await encode(plan.format, plan.quality);
        outcome.blob = encoded.blob;
        outcome.encoder = encoded.encoder;
      } catch (error) {
        if (error instanceof JobError && error.code === "cancelled") throw error;
        outcome.problem = error instanceof JobError ? error.message : problemText(error, `${FORMAT_LABEL[plan.format]} encoding failed.`);
      }
      outcome.ms = Math.round(performance.now() - started);
    }

    return {
      id: job.id,
      decodedWidth: shownWidth,
      decodedHeight: shownHeight,
      outputWidth: target.width,
      outputHeight: target.height,
      resized: target.resized,
      usesTransparency: transparent,
      flattened,
      candidates: outcomes,
      decodeMs: Math.round(decodeMs),
    };
  } finally {
    try {
      decoded.release();
    } catch {
      /* already released */
    }
    discard(canvas);
  }
}
