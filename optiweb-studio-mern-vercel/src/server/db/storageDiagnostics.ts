/**
 * Safe diagnostics for MongoDB failures.
 *
 * A driver error can contain the connection string, a user name, a host name or
 * the key of a rejected document. None of that may reach a log line or a
 * response. This module reduces every failure to:
 *
 *  - a category from a fixed list, with a fixed message and hint that are safe
 *    to show to anyone, and
 *  - a structured log entry built only from that category, the request ID and
 *    identifiers that cannot carry secrets (error class names and error codes).
 *
 * The error's `message` is read to choose a category and is then discarded.
 */
import { ApiError } from "../http/errors.js";
import { currentRequestId } from "../http/requestContext.js";
import type { StorageFailure, StorageFailureCategory } from "../../types/domain.js";

export type { StorageFailure, StorageFailureCategory };

/** What the storage layer was doing when the error was thrown. */
export type StorageStage = "connect" | "read" | "write" | "artifact_insert";

const DESCRIPTIONS: Record<StorageFailureCategory, { message: string; hint: string }> = {
  not_configured: {
    message: "Storage is not configured: MONGODB_URI is not set on the server.",
    hint: "Add MONGODB_URI to the environment variables of this deployment, then redeploy.",
  },
  invalid_uri: {
    message: "The MongoDB connection string is not valid.",
    hint: "It must start with mongodb:// or mongodb+srv://. Remove any quotes or spaces around the value, and URL-encode special characters in the password.",
  },
  dns_failure: {
    message: "The MongoDB host name could not be resolved.",
    hint: "Check the cluster host in MONGODB_URI, and copy the connection string again from Atlas if the cluster was renamed or deleted. A password containing @ : / ? or # must be URL-encoded, or part of it is read as the host.",
  },
  authentication_failed: {
    message: "MongoDB rejected the database user name or password.",
    hint: "Check the credentials in MONGODB_URI against the database user in Atlas. URL-encode special characters in the password.",
  },
  network_access_denied: {
    message: "MongoDB refused the connection from this server.",
    hint: "In Atlas, open Network Access and allow the addresses this server connects from. Serverless hosts such as Vercel and Netlify use changing addresses unless static egress is set up, in which case only 0.0.0.0/0 matches them. For a self-hosted database, check its firewall and TLS settings.",
  },
  connection_refused: {
    message: "Nothing accepted the connection at the MongoDB address.",
    hint: "Check the host and port in MONGODB_URI and that the database is running.",
  },
  server_selection_timeout: {
    message: "No MongoDB server responded in time.",
    hint: "Check that the cluster is running and not paused, and that Atlas Network Access allows this server.",
  },
  connection_failed: {
    message: "The connection to MongoDB could not be established.",
    hint: "Check MONGODB_URI, including its TLS options, and the cluster status in Atlas.",
  },
  connection_lost: {
    message: "The connection to MongoDB was lost during the operation.",
    hint: "Try again. If it keeps happening, check the cluster status in Atlas.",
  },
  permission_denied: {
    message: "The database user is not allowed to perform this operation.",
    hint: "Give the database user the readWrite role on the application database.",
  },
  write_failed: {
    message: "The database did not accept the write.",
    hint: "Try again. If it keeps happening, check the cluster's storage quota and health in Atlas.",
  },
  artifact_insert_failed: {
    message: "The database did not accept the output files, so the job was not stored.",
    hint: "Try again. If it keeps happening, check the cluster's storage quota in Atlas.",
  },
  read_failed: {
    message: "The database could not complete the read.",
    hint: "Try again. If it keeps happening, check the cluster status in Atlas.",
  },
};

/** Every category, in the order they are documented. */
export const STORAGE_FAILURE_CATEGORIES = Object.keys(DESCRIPTIONS) as StorageFailureCategory[];

export function describeStorageFailure(category: StorageFailureCategory): StorageFailure {
  return { category, ...DESCRIPTIONS[category] };
}

/**
 * A storage failure as an API error: HTTP 503 with the fixed wording for its
 * category. It never carries the original exception.
 */
export class StorageUnavailableError extends ApiError {
  readonly category: StorageFailureCategory;

  /**
   * `cause` keeps the driver error in memory so the caller's log entry can
   * include its class name and code. It is never serialised: the response
   * mapper reads only `code`, `message`, `hint` and `details`.
   */
  constructor(category: StorageFailureCategory, options?: { cause?: unknown }) {
    const description = DESCRIPTIONS[category];
    super(503, "storage_unavailable", description.message, { hint: description.hint, details: { category } });
    this.name = "StorageUnavailableError";
    this.category = category;
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false, writable: false });
    }
  }
}

/* ----------------------------- classification ----------------------------- */

type Evidence = { name: string; code: string; codeName: string; syscall: string; message: string };

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/**
 * Flattens an error, its causes and, for server-selection errors, the error
 * recorded for each server. Reading is defensive: a driver object with an
 * unexpected shape must never turn a diagnostic into a second failure.
 */
function collectEvidence(error: unknown): Evidence[] {
  const found: Evidence[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 5 || found.length >= 24) return;
    seen.add(value);
    try {
      const item = value as Record<string, unknown>;
      const entry: Evidence = {
        name: text(item.name),
        code: text(item.code),
        codeName: text(item.codeName),
        syscall: text(item.syscall),
        message: text(item.message),
      };
      if (entry.name || entry.code || entry.codeName || entry.syscall || entry.message) found.push(entry);
      visit(item.cause, depth + 1);
      visit(item.error, depth + 1);
      visit(item.reason, depth + 1);
      if (item.servers instanceof Map) for (const server of item.servers.values()) visit(server, depth + 1);
      if (Array.isArray(item.errors)) for (const nested of item.errors) visit(nested, depth + 1);
      if (Array.isArray(item.writeErrors)) for (const nested of item.writeErrors) visit(nested, depth + 1);
    } catch {
      /* ignore unreadable properties */
    }
  };
  visit(error, 0);
  return found;
}

const has = (evidence: Evidence[], test: (entry: Evidence) => boolean): boolean => evidence.some(test);

/** Wrong, missing or revoked credentials. */
const isAuthentication = (entry: Evidence): boolean =>
  entry.code === "18" ||
  entry.codeName === "AuthenticationFailed" ||
  /bad auth|authentication failed|requires authentication|SCRAM/i.test(entry.message) ||
  entry.name === "MongoMissingCredentialsError";

/** Valid credentials, but the user's roles do not cover the operation. */
const isPermission = (entry: Evidence): boolean =>
  entry.code === "13" || entry.codeName === "Unauthorized" || /not authorized|not allowed to do action/i.test(entry.message);

const isDns = (entry: Evidence): boolean =>
  /^(query|getaddrinfo)/i.test(entry.syscall) ||
  ["ENOTFOUND", "EAI_AGAIN", "ENODATA", "ESERVFAIL"].includes(entry.code) ||
  /getaddrinfo|querySrv|queryTxt/.test(entry.message);

const isInvalidUri = (entry: Evidence): boolean =>
  ["MongoParseError", "MongoInvalidArgumentError", "MongoAPIError", "URIError"].includes(entry.name) ||
  entry.code === "ERR_INVALID_URL" ||
  /Invalid scheme|Invalid connection string|URI malformed|must be a string|unescaped characters|URI must include|mongodb\+srv URI cannot/i.test(entry.message);

const isCertificateProblem = (entry: Evidence): boolean => /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT/.test(entry.code);

/** The peer accepted the TCP connection and then dropped it, typically during the TLS handshake. */
const isDroppedByPeer = (entry: Evidence): boolean =>
  ["ECONNRESET", "EPIPE", "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR"].includes(entry.code) ||
  /socket disconnected before secure TLS connection|alert internal error|SSL alert number 80|closed by peer|socket hang up|connection .{0,80} closed/i.test(entry.message);

const isRefused = (entry: Evidence): boolean => entry.code === "ECONNREFUSED" && !/^query/i.test(entry.syscall);

const isServerSelection = (entry: Evidence): boolean =>
  entry.name === "MongoServerSelectionError" || entry.name === "MongooseServerSelectionError" || /Server selection timed out/i.test(entry.message);

const isNetwork = (entry: Evidence): boolean =>
  [
    "MongoNetworkError",
    "MongoNetworkTimeoutError",
    "MongoPoolClearedError",
    "PoolClearedError",
    "MongoPoolClosedError",
    "MongoNotConnectedError",
    "MongoTopologyClosedError",
    "MongoServerClosedError",
  ].includes(entry.name) ||
  ["ECONNRESET", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNREFUSED"].includes(entry.code) ||
  /buffering timed out|Client must be connected|not connected|connection .{0,80} closed|force closed/i.test(entry.message);

function classifyConnectFailure(evidence: Evidence[]): StorageFailureCategory {
  if (has(evidence, isAuthentication)) return "authentication_failed";
  if (has(evidence, isDns)) return "dns_failure";
  if (has(evidence, isCertificateProblem)) return "connection_failed";
  if (has(evidence, isDroppedByPeer)) return "network_access_denied";
  if (has(evidence, isRefused)) return "connection_refused";
  if (has(evidence, isServerSelection) || has(evidence, isNetwork)) return "server_selection_timeout";
  if (has(evidence, isInvalidUri)) return "invalid_uri";
  if (has(evidence, isPermission)) return "permission_denied";
  return "connection_failed";
}

const STAGE_DEFAULT: Record<Exclude<StorageStage, "connect">, StorageFailureCategory> = {
  read: "read_failed",
  write: "write_failed",
  artifact_insert: "artifact_insert_failed",
};

/**
 * Chooses the category for an error thrown at `stage`.
 *
 * During `connect`, the question is why the connection could not be made.
 * During any later stage the connection already worked once. A server-selection
 * error there means it has to be made again and could not be, so it is
 * classified like a connect failure. Anything else that is not about
 * credentials, permissions or a dropped connection is a failure of the
 * operation itself.
 */
export function classifyStorageError(error: unknown, stage: StorageStage): StorageFailureCategory {
  if (error instanceof StorageUnavailableError) return error.category;
  const evidence = collectEvidence(error);
  if (stage === "connect") return classifyConnectFailure(evidence);
  if (has(evidence, isAuthentication)) return "authentication_failed";
  if (has(evidence, isPermission)) return "permission_denied";
  if (has(evidence, isServerSelection)) return classifyConnectFailure(evidence);
  if (has(evidence, isNetwork) || has(evidence, isDroppedByPeer)) return "connection_lost";
  return STAGE_DEFAULT[stage];
}

/* --------------------------------- logging --------------------------------- */

/** Keeps an identifier only if it is a plain token. Anything else could be free text. */
function token(value: unknown, pattern: RegExp): string | null {
  const candidate = text(value);
  return candidate && pattern.test(candidate) ? candidate : null;
}

const NAME_TOKEN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const CODE_TOKEN = /^[A-Za-z0-9_]{1,48}$/;

/** A finer, still enumerated, reason for a write failure. Server logs only. */
function writeDetail(evidence: Evidence[]): string | null {
  if (has(evidence, (entry) => entry.code === "11000")) return "duplicate_key";
  if (has(evidence, (entry) => entry.code === "121" || entry.codeName === "DocumentValidationFailure")) return "document_validation_failed";
  if (has(evidence, (entry) => entry.code === "10334" || entry.codeName === "BSONObjectTooLarge" || /BSONObj size|larger than the maximum size/i.test(entry.message))) {
    return "document_too_large";
  }
  if (has(evidence, (entry) => entry.code === "14031" || entry.codeName === "OutOfDiskSpace")) return "out_of_disk_space";
  if (has(evidence, (entry) => /over your space quota|quota/i.test(entry.message))) return "storage_quota_exceeded";
  if (has(evidence, (entry) => entry.name === "ValidationError")) return "schema_validation_failed";
  return null;
}

export type StorageLogEntry = {
  level: "error";
  event: "storage_failure" | "storage_rollback_failed";
  category: StorageFailureCategory;
  /** The storage operation that failed, for example "job.persist" or "history.list". */
  operation: string;
  stage: string;
  requestId: string | null;
  errorName: string | null;
  errorCode: string | null;
  errorCodeName: string | null;
  /** Error class names and codes found on the underlying errors, for example ["MongoNetworkError", "ECONNRESET"]. */
  causes: string[];
  detail: string | null;
  rollback?: "not_needed" | "completed" | "failed";
  jobId?: string;
  durationMs?: number;
  timestamp: string;
};

export type StorageLogInput = {
  event?: StorageLogEntry["event"];
  category: StorageFailureCategory;
  operation: string;
  stage: string;
  error: unknown;
  rollback?: StorageLogEntry["rollback"];
  /** Opaque job UUID. Logged only when a rollback failed, so the leftover record can be found. */
  jobId?: string;
  durationMs?: number;
};

/** Builds the log entry. Exported so tests can assert on exactly what is written. */
export function buildStorageLogEntry(input: StorageLogInput): StorageLogEntry {
  const evidence = collectEvidence(input.error);
  const top = evidence[0];
  const causes = new Set<string>();
  for (const entry of evidence.slice(1)) {
    const name = token(entry.name, NAME_TOKEN);
    const code = token(entry.code, CODE_TOKEN);
    if (name && name !== "Error") causes.add(name);
    if (code) causes.add(code);
    if (causes.size >= 6) break;
  }
  return {
    level: "error",
    event: input.event ?? "storage_failure",
    category: input.category,
    operation: input.operation,
    stage: input.stage,
    requestId: currentRequestId(),
    errorName: token(top?.name, NAME_TOKEN),
    errorCode: token(top?.code, CODE_TOKEN),
    errorCodeName: token(top?.codeName, NAME_TOKEN),
    causes: Array.from(causes),
    detail: writeDetail(evidence),
    ...(input.rollback ? { rollback: input.rollback } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.durationMs === undefined ? {} : { durationMs: Math.round(input.durationMs) }),
    timestamp: new Date().toISOString(),
  };
}

/** Writes one JSON line to the server log. The line never contains an error message. */
export function logStorageFailure(input: StorageLogInput): StorageLogEntry {
  const entry = buildStorageLogEntry(input);
  console.error(JSON.stringify(entry));
  return entry;
}
