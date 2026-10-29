/** Multipart upload handling: bounded, allowlisted, and mime-agnostic. */
import { limits } from "@/server/config/env";
import { badRequest, payloadTooLarge, tooManyFiles } from "@/server/http/errors";

export type UploadFile = {
  field: string;
  filename: string;
  contentType: string;
  buffer: Buffer;
};

export type MultipartPayload = {
  files: UploadFile[];
  fields: Record<string, string>;
};

export async function readMultipart(
  req: Request,
  options: { kind: "image" | "asset"; maxFiles?: number } = { kind: "image" },
): Promise<MultipartPayload> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    throw badRequest("Expected a multipart/form-data upload.");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw badRequest("The upload could not be read. It may be truncated or malformed.");
  }

  const maxFiles = options.maxFiles ?? limits.maxFilesPerRequest;
  const fields: Record<string, string> = {};
  const files: UploadFile[] = [];
  let batchBytes = 0;

  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      if (fields[key] === undefined) fields[key] = value;
      continue;
    }
    if (files.length >= maxFiles) {
      throw tooManyFiles(
        `This endpoint accepts at most ${maxFiles} files per request.`,
        "Split the batch into smaller groups.",
      );
    }
    const file = value as File;
    if (file.size === 0) continue;
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.byteLength > limits.maxFileBytes) {
      throw payloadTooLarge(
        `"${file.name}" exceeds the ${(limits.maxFileBytes / (1024 * 1024)).toFixed(0)} MB per-file limit.`,
        "Downscale the image locally, then upload again.",
      );
    }
    // Optional total-body budget (0 disables the check). Guards both host-level
    // request caps and memory use on self-hosted deployments.
    if (limits.maxBatchBytes > 0) {
      batchBytes += buffer.byteLength;
      if (batchBytes > limits.maxBatchBytes) {
        throw payloadTooLarge(
          `This batch exceeds the ${(limits.maxBatchBytes / (1024 * 1024)).toFixed(1)} MB total upload limit.`,
          "Send fewer or smaller files per request.",
        );
      }
    }
    files.push({
      field: key,
      filename: file.name || "upload",
      contentType: file.type || "application/octet-stream",
      buffer,
    });
  }

  if (files.length === 0) {
    throw badRequest("No files were received.", "Attach at least one file and try again.");
  }

  return { files, fields };
}

