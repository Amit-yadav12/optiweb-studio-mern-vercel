/**
 * A scripted stand-in for a MongoDB server, for failure-path tests only.
 *
 * It speaks just enough of the MongoDB wire protocol for the real driver to
 * connect and send commands, and it answers each command with a canned reply
 * or with a reply chosen by the test. That lets a test make the driver raise a
 * specific, genuine driver error (authentication rejected, write rejected,
 * insert rejected, delete rejected) without a database.
 *
 * It stores nothing and implements no query semantics, so it is NOT evidence
 * that persistence works. Tests of real persistence run against a real MongoDB
 * server; see scripts/storage-mongo-selftest.mjs.
 */
import net from "node:net";
import mongoose from "mongoose";

const { BSON } = mongoose.mongo;
const OP_REPLY = 1;
const OP_QUERY = 2004;
const OP_MSG = 2013;

/** Error replies shaped like the ones a real server sends. */
export const serverErrors = {
  authenticationFailed: { ok: 0, errmsg: "Authentication failed.", code: 18, codeName: "AuthenticationFailed" },
  atlasBadAuth: { ok: 0, errmsg: "bad auth : authentication failed", code: 8000, codeName: "AtlasError" },
  unauthorized: (command) => ({ ok: 0, errmsg: `not authorized on db to execute command { ${command}: 1 }`, code: 13, codeName: "Unauthorized" }),
  documentValidation: (count = 1) => ({
    ok: 1,
    n: 0,
    writeErrors: Array.from({ length: Math.min(count, 1) }, (_, index) => ({ index, code: 121, errmsg: "Document failed validation" })),
  }),
  outOfDiskSpace: { ok: 0, errmsg: "Out of disk space", code: 14031, codeName: "OutOfDiskSpace" },
  quotaExceeded: { ok: 0, errmsg: "you are over your space quota, using 513 MB of 512 MB", code: 8000, codeName: "AtlasError" },
};

function helloReply() {
  return {
    helloOk: true,
    ismaster: true,
    isWritablePrimary: true,
    maxBsonObjectSize: 16 * 1024 * 1024,
    maxMessageSizeBytes: 48_000_000,
    maxWriteBatchSize: 100_000,
    localTime: new Date(),
    minWireVersion: 0,
    maxWireVersion: 21,
    readOnly: false,
    ok: 1,
  };
}

function emptyCursor(namespace) {
  return { ok: 1, cursor: { id: BSON.Long.fromNumber(0), ns: namespace, firstBatch: [] } };
}

function defaultReply(name, command, documentCount) {
  const namespace = `${command.$db ?? "admin"}.${typeof command[name] === "string" ? command[name] : "$cmd"}`;
  switch (name) {
    case "hello":
    case "isMaster":
    case "ismaster":
      return helloReply();
    case "saslStart":
    case "saslContinue":
      // The stand-in has no user database, so credentials are always rejected.
      return serverErrors.authenticationFailed;
    case "insert":
      return { ok: 1, n: documentCount };
    case "delete":
      return { ok: 1, n: 0 };
    case "update":
      return { ok: 1, n: 0, nModified: 0 };
    case "findAndModify":
      return { ok: 1, value: null, lastErrorObject: { n: 0, updatedExisting: false } };
    case "find":
    case "aggregate":
    case "listCollections":
    case "listIndexes":
      return emptyCursor(namespace);
    case "ping":
    case "create":
    case "createIndexes":
    case "endSessions":
    case "killCursors":
      return { ok: 1 };
    default:
      return { ok: 0, errmsg: `no such command: '${name}'`, code: 59, codeName: "CommandNotFound" };
  }
}

function header(length, requestId, responseTo, opCode) {
  const buffer = Buffer.alloc(16);
  buffer.writeInt32LE(length, 0);
  buffer.writeInt32LE(requestId, 4);
  buffer.writeInt32LE(responseTo, 8);
  buffer.writeInt32LE(opCode, 12);
  return buffer;
}

/**
 * Reads one OP_MSG. Documents sent in a sequence section (the `documents` of an
 * insert, the `deletes` of a delete) are attached to the command under the
 * section's name, which is where they would be if they had been sent inline.
 */
function readMessage(body) {
  let offset = 4; // flag bits
  let command = {};
  const sequences = {};
  while (offset < body.length) {
    const kind = body.readUInt8(offset);
    offset += 1;
    if (kind === 0) {
      const size = body.readInt32LE(offset);
      command = BSON.deserialize(body.subarray(offset, offset + size));
      offset += size;
    } else if (kind === 1) {
      const end = offset + body.readInt32LE(offset);
      offset += 4;
      const nameStart = offset;
      while (body[offset] !== 0) offset += 1;
      const name = body.toString("utf8", nameStart, offset);
      offset += 1;
      const documents = (sequences[name] ??= []);
      while (offset < end) {
        const size = body.readInt32LE(offset);
        documents.push(BSON.deserialize(body.subarray(offset, offset + size)));
        offset += size;
      }
    } else {
      break; // checksum or an unknown section: nothing more to read
    }
  }
  command = { ...command, ...sequences };
  return { command, documentCount: Array.isArray(command.documents) ? command.documents.length : 0 };
}

/** Reads the command document of a legacy OP_QUERY, which the driver uses for its first handshake. */
function readQuery(body) {
  let offset = 4; // flags
  while (body[offset] !== 0) offset += 1; // full collection name
  offset += 1 + 8; // terminator, numberToSkip, numberToReturn
  const size = body.readInt32LE(offset);
  return BSON.deserialize(body.subarray(offset, offset + size));
}

/**
 * Starts the stand-in on a local port (a free one unless `port` is given).
 *
 * `script(name, command, { collection, documentCount })` may return a reply
 * document to override the default for that command, the string "hang" to
 * leave it unanswered, or the string "close" to drop the connection. Returning
 * nothing uses the default reply.
 */
export async function startScriptedMongoServer(script = () => undefined, { port: requestedPort = 0 } = {}) {
  const commands = [];
  const sockets = new Set();
  let nextRequestId = 1;
  let behaviour = script;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 16) {
        const length = pending.readInt32LE(0);
        if (pending.length < length) break;
        const message = pending.subarray(0, length);
        pending = pending.subarray(length);
        const requestId = message.readInt32LE(4);
        const opCode = message.readInt32LE(12);
        const body = message.subarray(16);
        if (opCode !== OP_MSG && opCode !== OP_QUERY) continue;

        const { command, documentCount } = opCode === OP_MSG ? readMessage(body) : { command: readQuery(body), documentCount: 0 };
        const name = Object.keys(command)[0] ?? "";
        const collection = typeof command[name] === "string" ? command[name] : null;
        commands.push({ name, collection, database: command.$db ?? null, documentCount, command });

        const scripted = behaviour(name, command, { collection, documentCount });
        if (scripted === "hang") continue;
        if (scripted === "close") { socket.destroy(); return; }
        const document = BSON.serialize(scripted ?? defaultReply(name, command, documentCount));
        if (opCode === OP_MSG) {
          const prefix = Buffer.alloc(5); // flag bits (0) and section kind (0)
          socket.write(Buffer.concat([header(16 + 5 + document.length, nextRequestId++, requestId, OP_MSG), prefix, document]));
        } else {
          const prefix = Buffer.alloc(20); // response flags, cursor ID, starting from, number returned
          prefix.writeInt32LE(8, 0);
          prefix.writeInt32LE(1, 16);
          socket.write(Buffer.concat([header(16 + 20 + document.length, nextRequestId++, requestId, OP_REPLY), prefix, document]));
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    port,
    /** Connection string for a database on this stand-in. Pass credentials to exercise the authentication handshake. */
    uri: (database = "optiweb_scripted", credentials = "") => `mongodb://${credentials ? `${credentials}@` : ""}127.0.0.1:${port}/${database}`,
    /** Every command received so far, in order. */
    commands,
    /** Commands with the given name, optionally limited to one collection. */
    received: (name, collection) => commands.filter((entry) => entry.name === name && (collection === undefined || entry.collection === collection)),
    /** Replaces the script for subsequent commands. */
    setScript(next) { behaviour = next ?? (() => undefined); },
    clear() { commands.length = 0; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
