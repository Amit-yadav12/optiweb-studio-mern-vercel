import { crc32 } from "node:zlib";
import { badRequest, payloadTooLarge } from "../../../http/errors.js";
import { binaryOk, contentDisposition, parseJson, route, streamOk, type RouteContext } from "../../../http/handler.js";
import { objectArtifacts, recordDownload } from "../../../pipeline/views.js";
import { zipLength, zipStream, type ZipEntry } from "../../../pipeline/zipStream.js";
import { getArtifactsByIds } from "../../../services/storageService.js";
import { artifactZipSchema } from "../../../validators/index.js";
import { capacity, limits } from "../../../config/env.js";
import JSZip from "jszip";

/** A ZIP entry whose bytes are already in memory. */
function bufferEntry(name: string, data: Buffer, modified: Date): ZipEntry {
  return {
    name,
    bytes: data.byteLength,
    crc32: crc32(data) >>> 0,
    modified,
    open: async () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } }),
  };
}

/** POST /api/v1/artifacts/zip — bundles results that belong to this session. */
export const POST = route(async (req, ctx) => {
  const { ids, name } = await parseJson(req, artifactZipSchema);
  return bundle(ctx, ids, name);
}, { bucket: "artifacts" });

/**
 * GET /api/v1/artifacts/zip?ids=a,b,c — the same bundle as a plain link, so
 * that the browser's own download writes a large archive to disk as it
 * arrives. The request only reads, and only this session's files.
 */
export const GET = route(async (req, ctx) => {
  const params = new URL(req.url).searchParams;
  const { ids, name } = artifactZipSchema.parse({ ids: (params.get("ids") ?? "").split(",").filter(Boolean), name: params.get("name") ?? undefined });
  return bundle(ctx, ids, name);
}, { bucket: "artifacts" });

async function bundle(ctx: RouteContext, ids: string[], name: string | undefined): Promise<Response> {
  const downloadName = (name?.trim() || "optiweb-results").replace(/[^\w.-]+/g, "-").slice(0, 60);

  // Files kept in object storage are bundled as a stream: each one is copied
  // from storage into the response in turn, so the archive is never held in
  // memory and is not bound by the limit on buffered responses.
  const stored = await objectArtifacts(ctx.sessionId, ids);
  if (stored.length > 0) {
    const storedIds = new Set(stored.map((artifact) => artifact.id));
    const inline = await getArtifactsByIds(ctx.sessionId, ids.filter((id) => !storedIds.has(id)));
    const totalBytes = stored.reduce((sum, artifact) => sum + artifact.bytes, 0) + inline.reduce((sum, artifact) => sum + artifact.data.byteLength, 0);
    if (totalBytes > capacity.maxZipBytes) {
      throw payloadTooLarge(
        `These ${stored.length + inline.length} files total ${(totalBytes / (1024 * 1024)).toFixed(1)} MB, above the ${(capacity.maxZipBytes / (1024 * 1024)).toFixed(0)} MB ZIP limit.`,
        "Download files individually, or split the selection.",
      );
    }
    const now = new Date();
    const manifest = Buffer.from(
      [
        "OptiWeb Studio — optimized asset bundle",
        `Generated: ${now.toISOString()}`,
        `Files: ${stored.length + inline.length}`,
        "",
        ...stored.map((artifact) => `${artifact.filename}\t${artifact.bytes} bytes\t${artifact.contentType}`),
        ...inline.map((artifact) => `${artifact.filename}\t${artifact.data.byteLength} bytes\t${artifact.contentType}`),
        "",
        "Sizes are measured from the produced files (output byte length), not estimated.",
      ].join("\n"),
      "utf8",
    );
    const entries: ZipEntry[] = [
      ...stored.map((artifact) => ({
        name: artifact.filename || "result",
        bytes: artifact.bytes,
        crc32: artifact.crc32,
        modified: artifact.createdAt,
        open: async () => (await artifact.open())?.stream ?? null,
      })),
      ...inline.map((artifact) => bufferEntry(artifact.filename || "result", artifact.data, now)),
      bufferEntry("optiweb-manifest.txt", manifest, now),
    ];
    const length = zipLength(entries);
    const counted = zipStream(entries).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: () => void recordDownload(length) }));
    return streamOk(counted, ctx, { contentType: "application/zip", bytes: length, disposition: contentDisposition(`${downloadName}.zip`) });
  }

  const artifacts = await getArtifactsByIds(ctx.sessionId, ids);
  if (artifacts.length === 0) {
    throw badRequest("None of the selected results are available.", "They may have expired. Re-run the optimization.");
  }

  const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.data.byteLength, 0);
  if (limits.maxZipBytes > 0 && totalBytes > limits.maxZipBytes) {
    throw payloadTooLarge(
      `These ${artifacts.length} files total ${(totalBytes / (1024 * 1024)).toFixed(1)} MB, above the ${(limits.maxZipBytes / (1024 * 1024)).toFixed(0)} MB ZIP limit.`,
      "Download files individually, or split the selection.",
    );
  }

  const zip = new JSZip();
  const used = new Set<string>();
  for (const artifact of artifacts) {
    let filename = artifact.filename || "result";
    let counter = 2;
    while (used.has(filename)) {
      filename = artifact.filename.replace(/(\.[^.]+)?$/, `-${counter}$1`);
      counter += 1;
    }
    used.add(filename);
    zip.file(filename, artifact.data);
  }

  // Manifest documents the real measured bytes for each bundled file.
  zip.file(
    "optiweb-manifest.txt",
    [
      "OptiWeb Studio — optimized asset bundle",
      `Generated: ${new Date().toISOString()}`,
      `Files: ${artifacts.length}`,
      "",
      ...artifacts.map((a) => `${a.filename}\t${a.data.byteLength} bytes\t${a.contentType}`),
      "",
      "Sizes are measured from the produced buffers (output byte length), not estimated.",
    ].join("\n"),
  );

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  // The ZIP envelope and manifest also consume bytes; check the actual response,
  // not only the sum of the source artifacts, before returning a serverless body.
  if (buffer.byteLength > limits.maxZipBytes) {
    throw payloadTooLarge(
      `The generated ZIP is ${(buffer.byteLength / (1024 * 1024)).toFixed(2)} MB, above the ${(limits.maxZipBytes / (1024 * 1024)).toFixed(1)} MB download limit.`,
      "Split the selection or download files individually.",
    );
  }
  return binaryOk(new Uint8Array(buffer), ctx, {
    contentType: "application/zip",
    filename: `${downloadName}.zip`,
    headers: { "content-length": String(buffer.byteLength) },
  });
}
