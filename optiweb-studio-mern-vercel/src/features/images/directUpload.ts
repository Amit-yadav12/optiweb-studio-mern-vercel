/**
 * Sends one file straight from the browser to object storage, using the
 * authorization the server issued for it. The file does not pass through the
 * application server, so it is not bound by the size limit of a function
 * request. Progress comes from real transfer events.
 */
import type { UploadGrantView } from "@/types/domain";

export type UploadProgress = { loaded: number; total: number };

export type UploadFn = (grant: UploadGrantView, file: File, options: { signal: AbortSignal; onProgress: (progress: UploadProgress) => void }) => Promise<void>;

export class UploadError extends Error {
  /** True when the upload was stopped on purpose. */
  readonly aborted: boolean;
  constructor(message: string, aborted = false) {
    super(message);
    this.name = "UploadError";
    this.aborted = aborted;
  }
}

/** PUT with upload progress. `fetch` cannot report upload progress, so this uses XMLHttpRequest. */
function putWithProgress(url: string, file: File, contentType: string, signal: AbortSignal, onProgress: (progress: UploadProgress) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.withCredentials = true;
    request.setRequestHeader("content-type", contentType);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress({ loaded: event.loaded, total: event.total });
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new UploadError(`Storage refused the upload (HTTP ${request.status}).`));
    };
    request.onerror = () => reject(new UploadError("The upload was interrupted by a network error."));
    request.onabort = () => reject(new UploadError("The upload was cancelled.", true));
    signal.addEventListener("abort", () => request.abort(), { once: true });
    if (signal.aborted) request.abort();
    else request.send(file);
  });
}

/** The default uploader: Vercel Blob in production, a same-origin PUT on a development server. */
export const uploadToStorage: UploadFn = async (grant, file, { signal, onProgress }) => {
  if (grant.transport === "local") {
    await putWithProgress(grant.uploadUrl, file, grant.contentType, signal, onProgress);
    return;
  }
  // Loaded on first use: the storage client is only needed for direct uploads.
  const { put } = await import("@vercel/blob/client");
  try {
    await put(grant.pathname, file, {
      access: grant.access,
      token: grant.clientToken,
      contentType: grant.contentType,
      multipart: grant.multipart,
      abortSignal: signal,
      onUploadProgress: ({ loaded, total }) => onProgress({ loaded, total }),
    });
  } catch (error) {
    if (signal.aborted) throw new UploadError("The upload was cancelled.", true);
    // The storage client's messages are for developers; show a fixed sentence instead.
    throw new UploadError(error instanceof Error && /too large|size/i.test(error.message) ? "Storage refused the upload: the file is larger than authorized." : "The upload to storage failed.");
  }
};
