/**
 * Server-generated object paths.
 *
 * A path never contains the session ID, which is the guest's only credential:
 * paths appear in storage dashboards and logs. The owner is identified by a
 * one-way key derived from the session ID instead. A browser never chooses a
 * path, and ownership is decided by the database record, not by the path.
 */
import { createHash } from "node:crypto";

/** One-way owner key for a session. 24 hex characters, safe to show in a path. */
export function ownerKey(sessionId: string): string {
  return createHash("sha256").update(`optiweb-owner:${sessionId}`).digest("hex").slice(0, 24);
}

/** Keeps a file name harmless inside a path: one segment, no control characters, bounded length. */
export function pathSegment(name: string): string {
  const cleaned = name
    .normalize("NFKC")
    // Control characters are removed on purpose; they must never reach a storage path.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^\.+/, "")
    .slice(-96);
  return cleaned || "file";
}

export function sourcePath(sessionId: string, jobId: string, uploadId: string, filename: string): string {
  return `src/${ownerKey(sessionId)}/${jobId}/${uploadId}/${pathSegment(filename)}`;
}

export function artifactPath(sessionId: string, jobId: string, itemId: string, filename: string): string {
  return `out/${ownerKey(sessionId)}/${jobId}/${itemId}/${pathSegment(filename)}`;
}

/** Whether `path` lies inside the area that belongs to this session. A second check behind the database record. */
export function isOwnedPath(sessionId: string, path: string): boolean {
  const key = ownerKey(sessionId);
  return (path.startsWith(`src/${key}/`) || path.startsWith(`out/${key}/`)) && !path.includes("..") && !path.includes("//");
}
