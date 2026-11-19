/**
 * Vercel Blob driver for a **private** store.
 *
 * Uploads: the server issues a client token that is valid for one pathname,
 * one content type, a maximum size and a short time. The browser uses it with
 * `put()` from `@vercel/blob/client`; the file never passes through a function.
 * The read-write token stays on the server.
 *
 * Reads: private blobs have no public URL. They are fetched here with the
 * read-write token and streamed to the caller.
 *
 * Every object is written with `ttlDays`, so the store deletes it on its own
 * even if the application's cleanup routine never runs.
 */
import {
  BlobAccessError,
  BlobNotFoundError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  BlobStoreNotFoundError,
  BlobStoreSuspendedError,
  del,
  get,
  head,
  put,
} from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { ObjectStorageError, type ObjectStorage, type StoredObject } from "./objectStorage.js";

/** Above this size an upload is split into parts, which are sent in parallel and retried individually. */
const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;

/** Reduces a provider error to a category. The provider's message is never passed on. */
function translate(error: unknown): ObjectStorageError {
  if (error instanceof ObjectStorageError) return error;
  if (error instanceof BlobAccessError || error instanceof BlobStoreNotFoundError || error instanceof BlobStoreSuspendedError) {
    return new ObjectStorageError("storage_misconfigured", { cause: error });
  }
  if (error instanceof BlobServiceNotAvailable || error instanceof BlobServiceRateLimited) {
    return new ObjectStorageError("storage_unavailable", { cause: error });
  }
  // Network failures and unknown provider errors are worth one more attempt.
  return new ObjectStorageError("storage_unavailable", { cause: error });
}

export function createVercelBlobStorage(token: string): ObjectStorage {
  return {
    driver: "vercel-blob",

    async authorizeUpload({ path, contentType, maxBytes, validUntil, ttlDays }) {
      try {
        const clientToken = await generateClientTokenFromReadWriteToken({
          token,
          pathname: path,
          maximumSizeInBytes: maxBytes,
          allowedContentTypes: [contentType],
          validUntil,
          // The server chose the pathname, so no suffix is added. Overwriting is
          // allowed so that a failed upload can be retried at the same path.
          addRandomSuffix: false,
          allowOverwrite: true,
          ttlDays,
        });
        return { transport: "vercel-blob", pathname: path, clientToken, access: "private", multipart: maxBytes > MULTIPART_THRESHOLD_BYTES };
      } catch (error) {
        throw translate(error);
      }
    },

    async head(path): Promise<StoredObject | null> {
      try {
        const found = await head(path, { token });
        return { path: found.pathname, bytes: found.size, contentType: found.contentType };
      } catch (error) {
        if (error instanceof BlobNotFoundError) return null;
        throw translate(error);
      }
    },

    async read(path) {
      try {
        // `useCache: false` reads from origin, so a file that was overwritten
        // by a retry is never served from an older cached copy.
        const result = await get(path, { access: "private", token, useCache: false });
        if (!result || result.statusCode !== 200) return null;
        return { stream: result.stream, bytes: result.blob.size, contentType: result.blob.contentType };
      } catch (error) {
        if (error instanceof BlobNotFoundError) return null;
        throw translate(error);
      }
    },

    async write(path, data, { contentType, ttlDays }) {
      try {
        const written = await put(path, data, {
          access: "private",
          token,
          contentType,
          addRandomSuffix: false,
          allowOverwrite: true,
          ttlDays,
          multipart: data.byteLength > MULTIPART_THRESHOLD_BYTES,
        });
        return { path: written.pathname, bytes: data.byteLength, contentType: written.contentType };
      } catch (error) {
        throw translate(error);
      }
    },

    async remove(paths) {
      if (paths.length === 0) return;
      try {
        // One request deletes up to 1,000 objects; a missing object is not an error.
        for (let start = 0; start < paths.length; start += 500) {
          await del(paths.slice(start, start + 500), { token });
        }
      } catch (error) {
        if (error instanceof BlobNotFoundError) return;
        throw translate(error);
      }
    },
  };
}
