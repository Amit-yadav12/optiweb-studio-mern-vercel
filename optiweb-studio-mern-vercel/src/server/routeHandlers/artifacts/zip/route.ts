import { badRequest, payloadTooLarge } from "@/server/http/errors";
import { binaryOk, parseJson, route } from "@/server/http/handler";
import { getArtifactsByIds } from "@/server/services/storageService";
import { artifactZipSchema } from "@/server/validators";
import { limits } from "@/server/config/env";
import JSZip from "jszip";


/** POST /api/v1/artifacts/zip — bundles results that belong to this session. */
export const POST = route(async (req, ctx) => {
  const { ids, name } = await parseJson(req, artifactZipSchema);
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
  const downloadName = (name?.trim() || "optiweb-results").replace(/[^\w.-]+/g, "-").slice(0, 60);

  return binaryOk(new Uint8Array(buffer), ctx, {
    contentType: "application/zip",
    filename: `${downloadName}.zip`,
    headers: { "content-length": String(buffer.byteLength) },
  });
}, { bucket: "artifacts" });
