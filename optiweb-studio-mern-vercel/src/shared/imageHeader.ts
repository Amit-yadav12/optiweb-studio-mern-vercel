/**
 * Reads what an image file says about itself, without decoding its pixels.
 *
 * The format is decided from the file's first bytes (its signature), never
 * from its name or the type a browser or server declared for it. Dimensions,
 * frame count, alpha and metadata markers are then read from the container
 * structure.
 *
 * Two callers depend on this being cheap and safe:
 *  - the browser tools, which use it to refuse an image before it is decoded
 *    (a small file can declare a raster of billions of pixels);
 *  - the website audit on the server, which reads the dimensions of images it
 *    fetched from other sites without handing those bytes to a decoder.
 *
 * Every read is bounds-checked and every loop advances or stops, so malformed
 * input produces `malformed: "<reason>"`, not an exception or a hang.
 */

export type ImageFormat = "jpeg" | "png" | "gif" | "webp" | "avif" | "heic" | "tiff" | "bmp" | "ico" | "svg";

export type ImageHeader = {
  format: ImageFormat;
  /** IANA media type of the detected format. */
  mime: string;
  /** Stored pixel dimensions. For a rotated photo these are the dimensions before the rotation is applied. */
  width: number | null;
  height: number | null;
  /** Frames (or pages) in the file. Null when the container does not make it cheap to count them. */
  frames: number | null;
  /** True when the file holds more than one frame. */
  animated: boolean;
  /** Whether the file can carry transparency. Null when the header does not say. */
  hasAlpha: boolean | null;
  /** Bits per channel. Null when the header does not say. */
  bitDepth: number | null;
  /**
   * EXIF orientation (1–8) of a JPEG, PNG, WebP or TIFF. Null when the file states none.
   * Values 5–8 include a quarter turn. AVIF and HEIC do not use this field: their
   * rotation is part of the image itself and is reported through `quarterTurned` only.
   */
  orientation: number | null;
  /** True when the image is shown rotated by a quarter turn, so its displayed width and height are swapped. */
  quarterTurned: boolean;
  /** Metadata markers found in the container. */
  metadata: { exif: boolean; gps: boolean; icc: boolean; xmp: boolean };
  /** Format-specific facts, already in words (for example "progressive", "8-bit palette"). */
  traits: string[];
  /** Set when the signature was recognised but the structure after it could not be read. */
  malformed?: string;
};

const MIME: Record<ImageFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  tiff: "image/tiff",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

export function mimeOfFormat(format: ImageFormat): string {
  return MIME[format];
}

/** Bounds-checked reader. Every getter returns `null` past the end of the data. */
class Reader {
  readonly length: number;
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.length = bytes.byteLength;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(offset: number): number | null {
    return offset >= 0 && offset < this.length ? this.bytes[offset] : null;
  }
  u16(offset: number, little = false): number | null {
    return offset >= 0 && offset + 2 <= this.length ? this.view.getUint16(offset, little) : null;
  }
  u24le(offset: number): number | null {
    return offset >= 0 && offset + 3 <= this.length ? this.bytes[offset] | (this.bytes[offset + 1] << 8) | (this.bytes[offset + 2] << 16) : null;
  }
  u32(offset: number, little = false): number | null {
    return offset >= 0 && offset + 4 <= this.length ? this.view.getUint32(offset, little) : null;
  }
  i32le(offset: number): number | null {
    return offset >= 0 && offset + 4 <= this.length ? this.view.getInt32(offset, true) : null;
  }
  /** True when the ASCII `text` sits at `offset`. */
  ascii(offset: number, text: string): boolean {
    if (offset < 0 || offset + text.length > this.length) return false;
    for (let index = 0; index < text.length; index += 1) {
      if (this.bytes[offset + index] !== text.charCodeAt(index)) return false;
    }
    return true;
  }
  /** Up to `max` bytes at `offset` as Latin-1 text. Used for short identifiers only. */
  text(offset: number, max: number): string {
    const end = Math.min(this.length, offset + max);
    let out = "";
    for (let index = Math.max(0, offset); index < end; index += 1) out += String.fromCharCode(this.bytes[index]);
    return out;
  }
}

function blank(format: ImageFormat): ImageHeader {
  return {
    format,
    mime: MIME[format],
    width: null,
    height: null,
    frames: 1,
    animated: false,
    hasAlpha: null,
    bitDepth: null,
    orientation: null,
    quarterTurned: false,
    metadata: { exif: false, gps: false, icc: false, xmp: false },
    traits: [],
  };
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

/** The format a file's first bytes identify, or null. Needs the first 32 bytes; SVG needs the first few kilobytes. */
export function sniffFormat(bytes: Uint8Array): ImageFormat | null {
  const r = new Reader(bytes);
  if (r.u8(0) === 0xff && r.u8(1) === 0xd8 && r.u8(2) === 0xff) return "jpeg";
  if (r.u32(0) === 0x89504e47 && r.u32(4) === 0x0d0a1a0a) return "png";
  if (r.ascii(0, "GIF87a") || r.ascii(0, "GIF89a")) return "gif";
  if (r.ascii(0, "RIFF") && r.ascii(8, "WEBP")) return "webp";
  if (r.ascii(4, "ftyp")) {
    // ISO base media file. The major brand and the compatible brands decide which codec is inside.
    const boxSize = r.u32(0) ?? 0;
    const end = Math.min(r.length, boxSize >= 16 ? boxSize : 16);
    const brands: string[] = [r.text(8, 4)];
    for (let offset = 16; offset + 4 <= end && brands.length < 32; offset += 4) brands.push(r.text(offset, 4));
    if (brands.includes("avif") || brands.includes("avis")) return "avif";
    if (brands.some((brand) => HEIF_BRANDS.has(brand))) return "heic";
    return null;
  }
  // TIFF: a byte-order mark, then the number 42 (or 43 for BigTIFF) in that byte order.
  const tiffMagic = r.u16(0) === 0x4949 ? r.u16(2, true) : r.u16(0) === 0x4d4d ? r.u16(2) : null;
  if (tiffMagic === 42 || tiffMagic === 43) return "tiff";
  if (r.ascii(0, "BM") && (r.u32(14, true) ?? 0) >= 12 && (r.u32(14, true) ?? 0) <= 124) return "bmp";
  if (r.u16(0) === 0 && r.u16(2, true) === 1 && (r.u16(4, true) ?? 0) > 0 && r.u8(9) === 0) return "ico";
  if (looksLikeSvg(bytes)) return "svg";
  return null;
}

/** Reads the header of an image. Returns null when the bytes are not a recognised image format. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const format = sniffFormat(bytes);
  if (format === null) return null;
  const header = blank(format);
  const r = new Reader(bytes);
  try {
    switch (format) {
      case "png":
        readPng(r, header);
        break;
      case "jpeg":
        readJpeg(r, header);
        break;
      case "gif":
        readGif(r, header);
        break;
      case "webp":
        readWebp(r, header);
        break;
      case "avif":
      case "heic":
        readHeif(r, header);
        break;
      case "tiff":
        readTiff(r, header);
        break;
      case "bmp":
        readBmp(r, header);
        break;
      case "ico":
        readIco(r, header);
        break;
      case "svg":
        readSvg(bytes, header);
        break;
    }
  } catch {
    header.malformed ??= "the file structure could not be read";
  }
  if (header.malformed === undefined && format !== "svg") {
    if (!isDimension(header.width) || !isDimension(header.height)) {
      header.malformed = "the file does not state valid dimensions";
      header.width = null;
      header.height = null;
    }
  }
  return header;
}

function isDimension(value: number | null): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
}

/* ------------------------------------ PNG ----------------------------------- */

const PNG_COLOUR: Record<number, { name: string; alpha: boolean }> = {
  0: { name: "greyscale", alpha: false },
  2: { name: "truecolour", alpha: false },
  3: { name: "palette", alpha: false },
  4: { name: "greyscale with alpha", alpha: true },
  6: { name: "truecolour with alpha", alpha: true },
};

function readPng(r: Reader, header: ImageHeader): void {
  if (r.u32(8) !== 13 || !r.ascii(12, "IHDR")) {
    header.malformed = "the PNG does not start with an IHDR chunk";
    return;
  }
  header.width = r.u32(16);
  header.height = r.u32(20);
  const depth = r.u8(24);
  const colour = r.u8(25);
  const interlace = r.u8(28);
  if (depth === null || colour === null || interlace === null || !(colour in PNG_COLOUR)) {
    header.malformed = "the PNG header is incomplete";
    return;
  }
  header.bitDepth = depth;
  header.hasAlpha = PNG_COLOUR[colour].alpha;
  header.traits.push(`${depth}-bit ${PNG_COLOUR[colour].name}`);
  if (interlace === 1) header.traits.push("interlaced (Adam7)");

  // Walk the chunk list. Each chunk is: length, type, data, CRC.
  let offset = 33;
  for (let guard = 0; guard < 200_000; guard += 1) {
    const length = r.u32(offset);
    if (length === null || offset + 8 > r.length) break;
    const type = r.text(offset + 4, 4);
    if (type === "acTL") {
      const frames = r.u32(offset + 8);
      if (frames !== null && frames > 0) {
        header.frames = frames;
        header.animated = frames > 1;
        header.traits.push("animated PNG (APNG)");
      }
    } else if (type === "tRNS") header.hasAlpha = true;
    else if (type === "eXIf") {
      header.metadata.exif = true;
      readExif(r, offset + 8, length, header);
    } else if (type === "iCCP") header.metadata.icc = true;
    else if (type === "iTXt" && r.text(offset + 8, 20).startsWith("XML:com.adobe.xmp")) header.metadata.xmp = true;
    else if (type === "IEND") break;
    const next = offset + 12 + length;
    if (next <= offset) break;
    offset = next;
  }
}

/* ----------------------------------- JPEG ----------------------------------- */

function readJpeg(r: Reader, header: ImageHeader): void {
  header.hasAlpha = false;
  let offset = 2;
  for (let guard = 0; guard < 100_000; guard += 1) {
    // A marker is 0xFF followed by a non-zero, non-0xFF byte. Fill bytes (0xFF) may precede it.
    if (r.u8(offset) !== 0xff) {
      header.malformed = "a JPEG segment marker is missing";
      return;
    }
    let marker = r.u8(offset + 1);
    while (marker === 0xff) {
      offset += 1;
      marker = r.u8(offset + 1);
    }
    if (marker === null) break;
    offset += 2;
    // Markers without a payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    const length = r.u16(offset);
    if (length === null || length < 2) {
      header.malformed = "a JPEG segment has an invalid length";
      return;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      header.bitDepth = r.u8(offset + 2);
      header.height = r.u16(offset + 3);
      header.width = r.u16(offset + 5);
      const components = r.u8(offset + 7);
      if (marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce) header.traits.push("progressive");
      else header.traits.push("baseline");
      if (components === 1) header.traits.push("greyscale");
      else if (components === 4) header.traits.push("CMYK");
      return;
    }
    if (marker === 0xe1 && r.ascii(offset + 2, "Exif\0\0")) {
      header.metadata.exif = true;
      readExif(r, offset + 8, length - 8, header);
    } else if (marker === 0xe1 && r.ascii(offset + 2, "http://ns.adobe.com/xap/1.0/")) header.metadata.xmp = true;
    else if (marker === 0xe2 && r.ascii(offset + 2, "ICC_PROFILE\0")) header.metadata.icc = true;
    else if (marker === 0xda) break; // Start of scan: a frame header would have come first.
    offset += length;
  }
  header.malformed = "the JPEG has no frame header";
}

/* ----------------------------------- EXIF ----------------------------------- */

/**
 * Reads the orientation and the presence of a GPS block from an EXIF payload
 * (a TIFF structure). Only the first directory is inspected.
 */
function readExif(r: Reader, start: number, length: number, header: ImageHeader): void {
  const end = Math.min(r.length, start + Math.max(0, length));
  const order = r.u16(start);
  if (order !== 0x4949 && order !== 0x4d4d) return;
  const little = order === 0x4949;
  if (r.u16(start + 2, little) !== 42) return;
  const ifd = r.u32(start + 4, little);
  if (ifd === null) return;
  const base = start + ifd;
  const count = r.u16(base, little);
  if (count === null) return;
  for (let index = 0; index < Math.min(count, 512); index += 1) {
    const entry = base + 2 + index * 12;
    if (entry + 12 > end) break;
    const tag = r.u16(entry, little);
    if (tag === 0x0112) {
      const orientation = r.u16(entry + 8, little);
      if (orientation !== null && orientation >= 1 && orientation <= 8) {
        header.orientation = orientation;
        header.quarterTurned = orientation >= 5;
        if (orientation > 1) header.traits.push(`EXIF orientation ${orientation}`);
      }
    } else if (tag === 0x8825) header.metadata.gps = true;
  }
}

/* ------------------------------------ GIF ----------------------------------- */

function readGif(r: Reader, header: ImageHeader): void {
  header.width = r.u16(6, true);
  header.height = r.u16(8, true);
  header.bitDepth = 8;
  header.hasAlpha = false;
  const packed = r.u8(10);
  if (packed === null) {
    header.malformed = "the GIF header is incomplete";
    return;
  }
  let offset = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  let frames = 0;
  const skipSubBlocks = (from: number): number => {
    let at = from;
    for (let guard = 0; guard < 50_000_000; guard += 1) {
      const size = r.u8(at);
      if (size === null) return r.length;
      at += 1 + size;
      if (size === 0) return at;
    }
    return r.length;
  };
  for (let guard = 0; guard < 1_000_000 && offset < r.length; guard += 1) {
    const block = r.u8(offset);
    if (block === 0x3b || block === null) break;
    if (block === 0x21) {
      const label = r.u8(offset + 1);
      // Graphic control extension: bit 0 of its flags marks a transparent colour.
      if (label === 0xf9 && ((r.u8(offset + 3) ?? 0) & 0x01) === 1) header.hasAlpha = true;
      offset = skipSubBlocks(offset + 2);
    } else if (block === 0x2c) {
      frames += 1;
      const flags = r.u8(offset + 9);
      if (flags === null) break;
      offset += 10 + (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
      offset = skipSubBlocks(offset + 1);
    } else {
      // Not a block type the format defines. Stop counting; what was read so far stands.
      break;
    }
  }
  header.frames = Math.max(1, frames);
  header.animated = frames > 1;
  if (header.animated) header.traits.push("animated");
}

/* ----------------------------------- WebP ----------------------------------- */

function readWebp(r: Reader, header: ImageHeader): void {
  const first = r.text(12, 4);
  header.bitDepth = 8;
  if (first === "VP8 ") {
    if (r.u8(23) !== 0x9d || r.u8(24) !== 0x01 || r.u8(25) !== 0x2a) {
      header.malformed = "the WebP frame header is invalid";
      return;
    }
    header.width = (r.u16(26, true) ?? 0) & 0x3fff;
    header.height = (r.u16(28, true) ?? 0) & 0x3fff;
    header.hasAlpha = false;
    header.traits.push("lossy");
    return;
  }
  if (first === "VP8L") {
    const bits = r.u32(21, true);
    if (r.u8(20) !== 0x2f || bits === null) {
      header.malformed = "the WebP lossless header is invalid";
      return;
    }
    header.width = (bits & 0x3fff) + 1;
    header.height = ((bits >>> 14) & 0x3fff) + 1;
    header.hasAlpha = ((bits >>> 28) & 1) === 1;
    header.traits.push("lossless");
    return;
  }
  if (first === "VP8X") {
    const flags = r.u8(20);
    const width = r.u24le(24);
    const height = r.u24le(27);
    if (flags === null || width === null || height === null) {
      header.malformed = "the WebP extended header is incomplete";
      return;
    }
    header.width = width + 1;
    header.height = height + 1;
    header.hasAlpha = (flags & 0x10) !== 0;
    header.metadata.icc = (flags & 0x20) !== 0;
    header.metadata.exif = (flags & 0x08) !== 0;
    header.metadata.xmp = (flags & 0x04) !== 0;
    const animated = (flags & 0x02) !== 0;
    // Walk the chunk list to count animation frames and see how the pixels are coded.
    let frames = 0;
    let coding: string | null = null;
    let offset = 12;
    for (let guard = 0; guard < 1_000_000; guard += 1) {
      const size = r.u32(offset + 4, true);
      if (size === null) break;
      const type = r.text(offset, 4);
      if (type === "ANMF") {
        frames += 1;
        // The frame's own image chunk follows its 16-byte frame header.
        coding ??= r.text(offset + 24, 4) === "VP8L" ? "lossless" : r.text(offset + 24, 4) === "VP8 " ? "lossy" : null;
      } else if (type === "VP8 ") coding ??= "lossy";
      else if (type === "VP8L") coding ??= "lossless";
      else if (type === "EXIF") readExif(r, r.ascii(offset + 8, "Exif\0\0") ? offset + 14 : offset + 8, size, header);
      const next = offset + 8 + size + (size & 1);
      if (next <= offset) break;
      offset = next;
    }
    if (coding) header.traits.push(coding);
    if (animated) {
      header.frames = Math.max(frames, 2);
      header.animated = true;
      header.traits.push("animated");
    }
    return;
  }
  header.malformed = "the WebP file has no image chunk";
}

/* ---------------------------- AVIF / HEIC (ISO BMFF) ------------------------- */

type Box = { type: string; start: number; end: number };

/** The boxes that lie directly inside [start, end). */
function boxes(r: Reader, start: number, end: number): Box[] {
  const found: Box[] = [];
  let offset = start;
  for (let guard = 0; guard < 4096 && offset + 8 <= end; guard += 1) {
    let size = r.u32(offset);
    const type = r.text(offset + 4, 4);
    let headerSize = 8;
    if (size === null) break;
    if (size === 1) {
      const high = r.u32(offset + 8);
      const low = r.u32(offset + 12);
      if (high === null || low === null) break;
      size = high * 2 ** 32 + low;
      headerSize = 16;
    } else if (size === 0) size = end - offset;
    if (size < headerSize) break;
    const boxEnd = Math.min(end, offset + size);
    found.push({ type, start: offset + headerSize, end: boxEnd });
    offset += size;
  }
  return found;
}

function readHeif(r: Reader, header: ImageHeader): void {
  const top = boxes(r, 0, r.length);
  const ftyp = top.find((box) => box.type === "ftyp");
  const brands: string[] = [];
  if (ftyp) {
    brands.push(r.text(ftyp.start, 4));
    for (let offset = ftyp.start + 8; offset + 4 <= ftyp.end && brands.length < 32; offset += 4) brands.push(r.text(offset, 4));
  }
  const sequence = brands.includes("avis") || brands.includes("msf1") || brands.includes("hevs") || top.some((box) => box.type === "moov");
  if (sequence) {
    header.animated = true;
    header.frames = null;
    header.traits.push("image sequence");
  }
  const meta = top.find((box) => box.type === "meta");
  if (!meta) {
    header.malformed = "the file has no image description (meta box)";
    return;
  }
  // `meta` is a full box: four bytes of version and flags precede its children.
  const children = boxes(r, meta.start + 4, meta.end);
  let primary: number | null = null;
  const pitm = children.find((box) => box.type === "pitm");
  if (pitm) primary = r.u8(pitm.start) === 0 ? r.u16(pitm.start + 4) : r.u32(pitm.start + 4);

  const iprp = children.find((box) => box.type === "iprp");
  if (!iprp) {
    header.malformed = "the file lists no image properties";
    return;
  }
  const iprpChildren = boxes(r, iprp.start, iprp.end);
  const ipco = iprpChildren.find((box) => box.type === "ipco");
  if (!ipco) {
    header.malformed = "the file lists no image properties";
    return;
  }
  const properties = boxes(r, ipco.start, ipco.end);

  // Which properties belong to the primary item. Without this, a tile or a
  // thumbnail could be mistaken for the image.
  let associated: Set<number> | null = null;
  const ipma = iprpChildren.find((box) => box.type === "ipma");
  if (ipma && primary !== null) {
    const version = r.u8(ipma.start) ?? 0;
    const wide = ((r.u8(ipma.start + 3) ?? 0) & 1) === 1;
    const entries = r.u32(ipma.start + 4) ?? 0;
    let offset = ipma.start + 8;
    for (let entry = 0; entry < Math.min(entries, 4096) && offset < ipma.end; entry += 1) {
      const item = version < 1 ? r.u16(offset) : r.u32(offset);
      offset += version < 1 ? 2 : 4;
      const count = r.u8(offset);
      if (item === null || count === null) break;
      offset += 1;
      const indices = new Set<number>();
      for (let index = 0; index < count; index += 1) {
        const value = wide ? r.u16(offset) : r.u8(offset);
        if (value === null) break;
        indices.add(wide ? value & 0x7fff : value & 0x7f);
        offset += wide ? 2 : 1;
      }
      if (item === primary) {
        associated = indices;
        break;
      }
    }
  }

  type Size = { width: number; height: number };
  let best: Size | null = null;
  let largest: Size | null = null;
  for (let index = 0; index < properties.length; index += 1) {
    const property = properties[index];
    // Property indices in the association table start at 1.
    const mine = associated === null || associated.has(index + 1);
    if (property.type === "ispe") {
      const width = r.u32(property.start + 4);
      const height = r.u32(property.start + 8);
      if (width === null || height === null) continue;
      if (largest === null || width * height > largest.width * largest.height) largest = { width, height };
      if (mine && associated !== null && best === null) best = { width, height };
    } else if (property.type === "pixi" && mine) {
      const channels = r.u8(property.start + 4);
      const depth = r.u8(property.start + 5);
      if (channels !== null && channels > 0 && depth !== null) header.bitDepth = depth;
    } else if (property.type === "irot" && mine) {
      const quarterTurns = (r.u8(property.start) ?? 0) & 3;
      if (quarterTurns === 1 || quarterTurns === 3) header.quarterTurned = true;
    } else if (property.type === "auxC") {
      if (r.text(property.start + 4, 64).includes("alpha")) header.hasAlpha = true;
    } else if (property.type === "colr" && r.text(property.start, 4) !== "nclx") header.metadata.icc = true;
  }
  header.hasAlpha ??= false;
  // When the association table could not be used, take the largest image: for
  // a limit on decoded pixels, overestimating is the safe direction.
  const chosen: Size | null = best ?? largest;
  if (!chosen) {
    header.malformed = "the file does not state its dimensions";
    return;
  }
  header.width = chosen.width;
  header.height = chosen.height;

  // Item types reveal EXIF and XMP payloads without reading them.
  const iinf = children.find((box) => box.type === "iinf");
  if (iinf) {
    const version = r.u8(iinf.start) ?? 0;
    for (const infe of boxes(r, iinf.start + (version === 0 ? 6 : 8), iinf.end)) {
      const infeVersion = r.u8(infe.start) ?? 0;
      if (infeVersion < 2) continue;
      const itemType = r.text(infe.start + (infeVersion === 2 ? 8 : 10), 4);
      if (itemType === "Exif") header.metadata.exif = true;
      if (itemType === "mime" && r.text(infe.start + (infeVersion === 2 ? 12 : 14), 48).includes("rdf+xml")) header.metadata.xmp = true;
    }
  }
}

/* ----------------------------------- TIFF ----------------------------------- */

function readTiff(r: Reader, header: ImageHeader): void {
  const little = r.u16(0) === 0x4949;
  if (r.u16(2, little) === 43) {
    header.malformed = "BigTIFF files are not read";
    return;
  }
  let ifd = r.u32(4, little);
  let pages = 0;
  const seen = new Set<number>();
  while (ifd !== null && ifd !== 0 && pages < 256 && !seen.has(ifd)) {
    seen.add(ifd);
    const count = r.u16(ifd, little);
    if (count === null) break;
    if (pages === 0) {
      for (let index = 0; index < count; index += 1) {
        const entry = ifd + 2 + index * 12;
        const tag = r.u16(entry, little);
        const type = r.u16(entry + 2, little);
        if (tag === null || type === null) break;
        const value = type === 3 ? r.u16(entry + 8, little) : type === 4 ? r.u32(entry + 8, little) : null;
        if (tag === 256) header.width = value;
        else if (tag === 257) header.height = value;
        else if (tag === 258) {
          const values = r.u32(entry + 4, little) ?? 1;
          header.bitDepth = values <= 2 ? value : r.u16(r.u32(entry + 8, little) ?? -1, little);
        } else if (tag === 274 && value !== null && value >= 1 && value <= 8) {
          header.orientation = value;
          header.quarterTurned = value >= 5;
        } else if (tag === 338) header.hasAlpha = value === 1 || value === 2;
        else if (tag === 0x8769) header.metadata.exif = true;
        else if (tag === 0x8825) header.metadata.gps = true;
        else if (tag === 0x8773) header.metadata.icc = true;
        else if (tag === 700) header.metadata.xmp = true;
      }
    }
    pages += 1;
    ifd = r.u32(ifd + 2 + count * 12, little);
  }
  if (pages === 0) {
    header.malformed = "the TIFF has no image directory";
    return;
  }
  // No ExtraSamples tag means the file declares no alpha channel.
  header.hasAlpha ??= false;
  header.frames = pages;
  header.animated = pages > 1;
  if (pages > 1) header.traits.push(`${pages} pages`);
}

/* ------------------------------------ BMP ----------------------------------- */

function readBmp(r: Reader, header: ImageHeader): void {
  const dib = r.u32(14, true);
  if (dib === 12) {
    header.width = r.u16(18, true);
    header.height = r.u16(20, true);
    header.bitDepth = null;
    return;
  }
  const width = r.i32le(18);
  const height = r.i32le(22);
  const bits = r.u16(28, true);
  header.width = width === null ? null : Math.abs(width);
  header.height = height === null ? null : Math.abs(height);
  if (bits !== null) header.traits.push(`${bits} bits per pixel`);
  header.hasAlpha = bits === 32 ? null : false;
}

/* ------------------------------------ ICO ----------------------------------- */

function readIco(r: Reader, header: ImageHeader): void {
  const count = r.u16(4, true) ?? 0;
  let width = 0;
  let height = 0;
  for (let index = 0; index < Math.min(count, 256); index += 1) {
    const entry = 6 + index * 16;
    const w = r.u8(entry);
    const h = r.u8(entry + 1);
    if (w === null || h === null) break;
    const realWidth = w === 0 ? 256 : w;
    const realHeight = h === 0 ? 256 : h;
    if (realWidth * realHeight > width * height) {
      width = realWidth;
      height = realHeight;
    }
  }
  header.width = width || null;
  header.height = height || null;
  header.frames = count;
  if (count > 1) header.traits.push(`${count} sizes`);
}

/* ------------------------------------ SVG ----------------------------------- */

function decodeText(bytes: Uint8Array, max: number): string {
  const slice = bytes.subarray(0, Math.min(bytes.byteLength, max));
  // UTF-16 with a byte order mark is the only non-UTF-8 encoding seen in practice.
  if (slice[0] === 0xff && slice[1] === 0xfe) return new TextDecoder("utf-16le").decode(slice);
  if (slice[0] === 0xfe && slice[1] === 0xff) return new TextDecoder("utf-16be").decode(slice);
  return new TextDecoder("utf-8", { fatal: false }).decode(slice);
}

/** The root `<svg …>` tag, when the text starts with one after any XML prologue. */
function svgRootTag(text: string): string | null {
  let rest = text.replace(/^\uFEFF/, "");
  for (let guard = 0; guard < 64; guard += 1) {
    rest = rest.replace(/^\s+/, "");
    if (rest.startsWith("<?")) {
      const end = rest.indexOf("?>");
      if (end === -1) return null;
      rest = rest.slice(end + 2);
    } else if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->");
      if (end === -1) return null;
      rest = rest.slice(end + 3);
    } else if (/^<!DOCTYPE/i.test(rest)) {
      // A doctype may hold an internal subset in square brackets.
      const subset = rest.indexOf("[");
      const close = rest.indexOf(">");
      if (close === -1) return null;
      if (subset !== -1 && subset < close) {
        const end = rest.indexOf("]>");
        if (end === -1) return null;
        rest = rest.slice(end + 2);
      } else rest = rest.slice(close + 1);
    } else break;
  }
  const match = /^<svg(?=[\s>/])[^>]*>?/i.exec(rest);
  return match ? match[0] : null;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const first = bytes[0];
  // Text starts with "<", whitespace or a byte order mark. Anything else is not SVG.
  if (first !== 0x3c && first !== 0x20 && first !== 0x09 && first !== 0x0a && first !== 0x0d && first !== 0xef && first !== 0xff && first !== 0xfe) return false;
  return svgRootTag(decodeText(bytes, 8192)) !== null;
}

function svgLength(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function readSvg(bytes: Uint8Array, header: ImageHeader): void {
  const head = decodeText(bytes, 8192);
  const tag = svgRootTag(head) ?? "";
  const attribute = (name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(1).find((value) => value !== undefined);
  header.frames = 1;
  header.hasAlpha = true;
  header.width = svgLength(attribute("width"));
  header.height = svgLength(attribute("height"));
  const viewBox = attribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (viewBox && viewBox.length === 4 && viewBox.every((value) => Number.isFinite(value))) {
    header.traits.push(`viewBox ${viewBox[2]} × ${viewBox[3]}`);
    header.width ??= viewBox[2] > 0 ? Math.round(viewBox[2]) : null;
    header.height ??= viewBox[3] > 0 ? Math.round(viewBox[3]) : null;
  }
  const whole = decodeText(bytes, 4 * 1024 * 1024).toLowerCase();
  if (whole.includes("<script")) header.traits.push("contains script");
  if (whole.includes("data:image/")) header.traits.push("embeds a raster image");
  if (/<(animate|animatetransform|animatemotion|set)[\s>]/.test(whole)) header.traits.push("animated (SMIL)");
}

/** Pixels the image decodes to, per frame. Null when the header gave no dimensions. */
export function pixelCount(header: Pick<ImageHeader, "width" | "height">): number | null {
  return header.width !== null && header.height !== null ? header.width * header.height : null;
}

/** Width and height as shown, with a quarter-turn rotation applied. */
export function displayedSize(header: Pick<ImageHeader, "width" | "height" | "quarterTurned">): { width: number | null; height: number | null } {
  return header.quarterTurned ? { width: header.height, height: header.width } : { width: header.width, height: header.height };
}
