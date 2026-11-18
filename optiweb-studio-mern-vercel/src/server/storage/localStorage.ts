/**
 * Disk-backed object storage for development and tests on a long-lived Node
 * server. It gives the pipeline the same contract as the Vercel Blob driver,
 * including uploads that go straight from the browser to storage: here the
 * "storage" is a signed, size-capped PUT route on this server.
 *
 * Not for serverless hosts: their disks are per-instance and temporary.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { ObjectStorageError, type ObjectStorage, type StoredObject, type UploadAuthorization } from "./objectStorage.js";

type Meta = { contentType: string };

/** Signing key for upload URLs. Random per process unless configured, so URLs do not survive a restart. */
const signingKey = (): Buffer => {
  const configured = process.env.OW_LOCAL_UPLOAD_SECRET;
  if (configured) return Buffer.from(configured, "utf8");
  const globalKey = globalThis as typeof globalThis & { __optiwebLocalUploadKey?: Buffer };
  return (globalKey.__optiwebLocalUploadKey ??= randomBytes(32));
};

const sign = (payload: string): string => createHmac("sha256", signingKey()).update(payload).digest("base64url");

export type LocalUploadClaims = { uploadId: string; path: string; contentType: string; maxBytes: number; validUntil: number };

const claimsPayload = (claims: LocalUploadClaims): string =>
  [claims.uploadId, claims.path, claims.contentType, claims.maxBytes, claims.validUntil].join("\n");

/** Checks the signature and expiry of a local upload URL. Returns the claims it was issued for, or null. */
export function verifyLocalUpload(claims: LocalUploadClaims, signature: string, now = Date.now()): boolean {
  const expected = Buffer.from(sign(claimsPayload(claims)));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given) && now <= claims.validUntil;
}

export type LocalStorage = ObjectStorage & {
  readonly driver: "local";
  /** Stores an upload body, refusing more than `maxBytes`. Used by the signed PUT route. */
  receive(objectPath: string, body: AsyncIterable<Uint8Array>, options: { contentType: string; maxBytes: number }): Promise<StoredObject>;
};

export function createLocalStorage(rootDir: string): LocalStorage {
  const root = path.resolve(rootDir);

  /** Maps an object path to a file inside the root. Anything that would leave the root is refused. */
  function fileFor(objectPath: string): string {
    const resolved = path.resolve(root, objectPath);
    if (!resolved.startsWith(root + path.sep) || objectPath.includes("\0")) throw new ObjectStorageError("storage_misconfigured");
    return resolved;
  }
  const metaFor = (file: string): string => `${file}.meta.json`;

  async function stat(objectPath: string): Promise<StoredObject | null> {
    const file = fileFor(objectPath);
    try {
      const [info, meta] = await Promise.all([fs.stat(file), fs.readFile(metaFor(file), "utf8")]);
      if (!info.isFile()) return null;
      return { path: objectPath, bytes: info.size, contentType: (JSON.parse(meta) as Meta).contentType };
    } catch {
      return null;
    }
  }

  return {
    driver: "local",

    async authorizeUpload({ uploadId, path: objectPath, contentType, maxBytes, validUntil }: UploadAuthorization) {
      fileFor(objectPath);
      const claims: LocalUploadClaims = { uploadId, path: objectPath, contentType, maxBytes, validUntil };
      const query = new URLSearchParams({ exp: String(validUntil), sig: sign(claimsPayload(claims)) });
      return { transport: "local", uploadUrl: `/api/v1/uploads/${uploadId}/content?${query.toString()}` };
    },

    head: stat,

    async read(objectPath) {
      const found = await stat(objectPath);
      if (!found) return null;
      const stream = Readable.toWeb(createReadStream(fileFor(objectPath))) as ReadableStream<Uint8Array>;
      return { stream, bytes: found.bytes, contentType: found.contentType };
    },

    async write(objectPath, data, { contentType }) {
      const file = fileFor(objectPath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, data);
      await fs.writeFile(metaFor(file), JSON.stringify({ contentType } satisfies Meta));
      return { path: objectPath, bytes: data.byteLength, contentType };
    },

    async receive(objectPath, body, { contentType, maxBytes }) {
      const file = fileFor(objectPath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const handle = await fs.open(file, "w");
      let total = 0;
      try {
        for await (const chunk of body) {
          total += chunk.byteLength;
          if (total > maxBytes) throw new ObjectStorageError("object_too_large");
          await handle.write(chunk);
        }
      } catch (error) {
        await handle.close();
        await fs.rm(file, { force: true });
        throw error;
      }
      await handle.close();
      await fs.writeFile(metaFor(file), JSON.stringify({ contentType } satisfies Meta));
      return { path: objectPath, bytes: total, contentType };
    },

    async remove(paths) {
      await Promise.all(
        paths.map(async (objectPath) => {
          const file = fileFor(objectPath);
          await Promise.all([fs.rm(file, { force: true }), fs.rm(metaFor(file), { force: true })]);
        }),
      );
    },
  };
}
