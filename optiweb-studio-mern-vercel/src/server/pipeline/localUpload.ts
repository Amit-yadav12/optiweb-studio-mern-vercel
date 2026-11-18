/**
 * Upload target of the local storage driver.
 *
 * With Vercel Blob the browser sends a file to the storage service. On a
 * development or test server there is no such service, so the file is sent to
 * this route instead. It plays the role of the storage service and enforces
 * what the storage service enforces: a signed, expiring authorization for one
 * upload, the declared content type, and a hard limit on the number of bytes.
 * The body is streamed to disk; it is never buffered or parsed.
 */
import { ApiError, conflict, notFound, payloadTooLarge, unsupportedMedia } from "../http/errors.js";
import { ObjectStorageError, getObjectStorage } from "../storage/objectStorage.js";
import { verifyLocalUpload, type LocalStorage } from "../storage/localStorage.js";
import { pipelineStore } from "./store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function receiveLocalUpload(input: {
  uploadId: string;
  sessionId: string | null;
  expires: number;
  signature: string;
  contentType: string;
  body: AsyncIterable<Uint8Array>;
}): Promise<{ uploadId: string; bytes: number }> {
  const storage = await getObjectStorage();
  if (!storage || storage.driver !== "local") throw notFound("API route not found.");
  const store = await pipelineStore();
  const item = input.sessionId && UUID.test(input.uploadId) ? await store.items.findOne({ _id: input.uploadId, sessionId: input.sessionId }) : null;
  if (!item) throw notFound("That upload does not exist in this session.");
  const claims = { uploadId: item._id, path: item.path, contentType: item.contentType, maxBytes: item.declaredBytes, validUntil: input.expires };
  if (!Number.isFinite(input.expires) || !verifyLocalUpload(claims, input.signature)) {
    throw new ApiError(401, "unauthorized", "The upload authorization is invalid or has expired.", { hint: "Request a new upload authorization." });
  }
  if (item.state !== "awaiting_upload") throw conflict("This file has already been uploaded or removed.");
  if (input.contentType.trim().toLowerCase().split(";")[0] !== item.contentType) {
    throw unsupportedMedia(`This upload must be sent as ${item.contentType}.`);
  }
  try {
    const stored = await (storage as LocalStorage).receive(item.path, input.body, { contentType: item.contentType, maxBytes: item.declaredBytes });
    return { uploadId: item._id, bytes: stored.bytes };
  } catch (error) {
    if (error instanceof ObjectStorageError && error.code === "object_too_large") {
      throw payloadTooLarge("The upload is larger than the size that was authorized.");
    }
    throw error;
  }
}
