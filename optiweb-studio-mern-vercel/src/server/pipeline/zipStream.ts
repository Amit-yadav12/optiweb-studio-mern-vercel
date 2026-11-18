/**
 * A ZIP archive written as a stream.
 *
 * Entries are stored without compression: the images are already compressed,
 * and it keeps memory use flat. Each entry's size and CRC-32 are known before
 * it is written (they are recorded when the file is generated), so every
 * header is complete, no data descriptors are needed, and the total length of
 * the archive is known in advance for the Content-Length header.
 *
 * While an entry is copied, its bytes are counted and checksummed. If either
 * differs from the record, the stream fails, so a client receives a truncated
 * download rather than an archive that silently contains the wrong bytes.
 */
import { crc32 } from "node:zlib";

export type ZipEntry = {
  name: string;
  bytes: number;
  crc32: number;
  modified: Date;
  open: () => Promise<ReadableStream<Uint8Array> | null>;
};

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
/** Bit 11: file names are UTF-8. */
const FLAGS = 0x0800;

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/** `name.ext`, `name-2.ext`, … so that two files with the same name both fit in one archive. */
export function uniqueZipNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((original) => {
    // Path separators and control characters are neutralised on purpose: an entry name must not become a path.
    // eslint-disable-next-line no-control-regex
    const name = original.replace(/[\\/\u0000-\u001f]/g, "_") || "file";
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let copy = 2; used.has(candidate.toLowerCase()); copy += 1) candidate = `${base}-${copy}${extension}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function localHeader(name: Buffer, entry: ZipEntry): Buffer {
  const { time, date } = dosDateTime(entry.modified);
  const header = Buffer.alloc(LOCAL_HEADER);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(FLAGS, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(entry.crc32 >>> 0, 14);
  header.writeUInt32LE(entry.bytes, 18);
  header.writeUInt32LE(entry.bytes, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name]);
}

function centralHeader(name: Buffer, entry: ZipEntry, offset: number): Buffer {
  const { time, date } = dosDateTime(entry.modified);
  const header = Buffer.alloc(CENTRAL_HEADER);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(FLAGS, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(entry.crc32 >>> 0, 16);
  header.writeUInt32LE(entry.bytes, 20);
  header.writeUInt32LE(entry.bytes, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

/** Exact size of the archive that `zipStream` produces for these entries. */
export function zipLength(entries: ZipEntry[]): number {
  const names = uniqueZipNames(entries.map((entry) => entry.name)).map((name) => Buffer.byteLength(name, "utf8"));
  return entries.reduce((sum, entry, index) => sum + LOCAL_HEADER + CENTRAL_HEADER + 2 * names[index] + entry.bytes, END_RECORD);
}

/** The archive as an async sequence of chunks. Entries are opened one at a time. */
export async function* zipChunks(entries: ZipEntry[]): AsyncGenerator<Uint8Array> {
  const names = uniqueZipNames(entries.map((entry) => entry.name)).map((name) => Buffer.from(name, "utf8"));
  const offsets: number[] = [];
  let offset = 0;
  for (const [index, entry] of entries.entries()) {
    offsets.push(offset);
    const header = localHeader(names[index], entry);
    yield header;
    offset += header.length;

    const stream = await entry.open();
    if (!stream) throw new Error("zip entry is not available");
    let written = 0;
    let checksum = 0;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (written > entry.bytes) throw new Error("zip entry is larger than recorded");
        checksum = crc32(value, checksum);
        yield value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (written !== entry.bytes || checksum >>> 0 !== entry.crc32 >>> 0) throw new Error("zip entry does not match its record");
    offset += written;
  }
  const directoryStart = offset;
  for (const [index, entry] of entries.entries()) {
    const header = centralHeader(names[index], entry, offsets[index]);
    yield header;
    offset += header.length;
  }
  const end = Buffer.alloc(END_RECORD);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - directoryStart, 12);
  end.writeUInt32LE(directoryStart, 16);
  yield end;
}

export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  const chunks = zipChunks(entries);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}
