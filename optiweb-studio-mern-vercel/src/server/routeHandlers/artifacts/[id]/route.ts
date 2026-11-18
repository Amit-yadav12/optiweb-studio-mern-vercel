import { binaryOk, routeWithParams, streamOk } from "../../../http/handler.js";
import { notFound } from "../../../http/errors.js";
import { findObjectArtifact, recordDownload } from "../../../pipeline/views.js";
import { getArtifact, isUuid } from "../../../services/storageService.js";


/**
 * GET /api/v1/artifacts/:id — streams a stored result.
 *
 * The artifact must belong to the caller's session. The id is validated as a
 * UUID before it reaches the database, so a malformed id is a normal 404 rather
 * than a query error. Ids are opaque and never joined into a filesystem path.
 */
export const GET = routeWithParams<{ id: string }>(async (req, ctx, { id }) => {
  if (!isUuid(id)) {
    throw notFound("That result has expired or belongs to another session.");
  }
  // `?inline=1` serves the bytes for an <img> preview; the default is a
  // download. `?download=1` is accepted as an explicit download.
  const params = new URL(req.url).searchParams;
  const inline = params.get("inline") === "1" && params.get("download") !== "1";
  const disposition = inline ? "inline" : "attachment";

  // A file kept in object storage is streamed from there. It has no public
  // URL: the only way to its bytes is this route, for the session that owns it.
  const stored = await findObjectArtifact(ctx.sessionId, id);
  if (stored === "expired") throw notFound("That result has expired and its file has been deleted.");
  if (stored) {
    const reader = await stored.open();
    if (!reader) throw notFound("That result is no longer in storage.");
    const safeName = (stored.filename || "result").replace(/[\r\n"\\/]/g, "_");
    // Count the download once the last byte has been handed over.
    const counted = reader.stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: () => void recordDownload(reader.bytes) }));
    return streamOk(counted, ctx, {
      contentType: stored.contentType,
      bytes: reader.bytes,
      disposition: `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      headers: { "x-optiweb-original-name": stored.itemFilename.replace(/[\r\n]/g, "") },
    });
  }

  const artifact = await getArtifact(ctx.sessionId, id);
  if (!artifact) throw notFound("That result has expired or belongs to another session.");

  // The stored artifact name describes the produced file (e.g.
  // "hero-optiweb.webp"); the item name is the original upload.
  const filename = artifact.filename || artifact.itemFilename || "result";
  const safe = filename.replace(/[\r\n"\\/]/g, "_");

  return binaryOk(new Uint8Array(artifact.data), ctx, {
    contentType: artifact.contentType,
    headers: {
      "content-length": String(artifact.data.byteLength),
      "content-disposition": `${disposition}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
      // Lets a client re-optimize or re-analyse a stored result under its original name.
      "x-optiweb-original-name": (artifact.itemFilename ?? safe).replace(/[\r\n]/g, ""),
    },
  });
}, { bucket: "artifacts" });
