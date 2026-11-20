/**
 * Shared helpers for the self-tests: a check counter that also writes GitHub
 * annotations, the API started inside the test process, and the fixture files.
 */
import { once } from "node:events";
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Counts checks. In GitHub Actions every failure is also written as a workflow
 * annotation, which can be read from the Checks API without the job log.
 */
export function createChecker(title) {
  let passed = 0;
  const failures = [];
  const annotate = (level, message) => {
    if (process.env.GITHUB_ACTIONS !== "true") return;
    const escaped = String(message).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.log(`::${level} title=${title}::${escaped}`);
  };
  const report = () => {
    console.log(`\n${passed} passed, ${failures.length} failed`);
    annotate(failures.length > 0 ? "error" : "notice", `${passed} passed, ${failures.length} failed`);
    if (failures.length > 0) {
      console.log("\nFailures:");
      for (const failure of failures) console.log(` - ${failure}`);
    }
    return failures.length === 0;
  };
  return {
    section(name) {
      console.log(`\n${name}`);
    },
    check(name, condition, detail = "") {
      const suffix = detail === "" || detail === undefined ? "" : ` — ${String(detail).slice(0, 500)}`;
      if (condition) {
        passed += 1;
        console.log(`  ✓ ${name}`);
      } else {
        failures.push(`${name}${suffix}`);
        console.log(`  ✗ ${name}${suffix}`);
        annotate("error", `${name}${suffix}`);
      }
      return Boolean(condition);
    },
    /** A fact worth reading that is neither a pass nor a failure. In GitHub Actions it becomes a notice. */
    note(message) {
      console.log(`  · ${message}`);
      annotate("notice", message);
    },
    /** Reports a crash as a failed run instead of an unexplained exit. */
    crashed(error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      failures.push(`self-test crashed: ${reason}`);
      annotate("error", `self-test crashed after ${passed} passing checks: ${reason.slice(0, 400)}`);
      console.log(error);
      report();
    },
    get passed() {
      return passed;
    },
    get failed() {
      return failures.length;
    },
    report,
  };
}

/**
 * Starts the Express app in this process on a free local port.
 *
 * `console.error` is captured instead of printed, because it is the channel
 * the server logs on. `takeLogs()` returns the captured lines and clears them.
 */
export async function startApi() {
  const captured = [];
  const originalError = console.error;
  console.error = (...args) => {
    captured.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  };

  const { default: app } = await import("../../src/app.ts");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  /** One request. Returns the raw body as well, so a test can scan everything the client received. */
  async function call(path, { headers, ...init } = {}) {
    const response = await fetch(`${base}${path}`, { redirect: "manual", ...init, headers: headers ?? {} });
    const bytes = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "";
    const isText = /json|text|javascript|xml/.test(type);
    let json = null;
    if (type.includes("json")) {
      try {
        json = JSON.parse(bytes.toString("utf8"));
      } catch {
        json = null;
      }
    }
    const headerText = Array.from(response.headers.entries()).map(([key, value]) => `${key}: ${value}`).join("\n");
    return {
      status: response.status,
      headers: response.headers,
      bytes,
      json,
      text: isText ? bytes.toString("utf8") : "",
      /** Headers plus body (text bodies only): everything a browser could read from this response. */
      visible: `${headerText}\n${isText ? bytes.toString("utf8") : ""}`,
    };
  }

  function takeLogs() {
    const lines = captured.splice(0, captured.length);
    return { lines, text: lines.join("\n") };
  }

  async function close() {
    console.error = originalError;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  return { base, port, server, call, takeLogs, close };
}

/* --------------------------------- fixtures -------------------------------- */

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** Absolute path of a committed fixture file. */
export function fixturePath(name) {
  return `${FIXTURE_DIR}${name}`;
}

/** A committed fixture file. The files were written once by a real encoder; see scripts/fixtures/README.md. */
export function fixture(name) {
  return readFileSync(fixturePath(name));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC. */
export function pngChunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A real, valid 8-bit RGB PNG of one colour, built with zlib. `extraChunks`
 * are inserted before the pixel data, which is where animation and metadata
 * chunks belong.
 */
export function solidPng(width, height, [r, g, b] = [32, 96, 200], extraChunks = []) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), ...extraChunks, pngChunk("IDAT", deflateSync(raw, { level: 9 })), pngChunk("IEND")]);
}

/**
 * A PNG whose header declares `width` × `height` but whose pixel data is a few
 * bytes: what a decompression bomb looks like from the outside. A decoder that
 * trusted the header would allocate width × height × 4 bytes.
 */
export function pngDeclaring(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(Buffer.alloc(64))), pngChunk("IEND")]);
}

/** An animated PNG: a valid still PNG plus the `acTL` chunk that declares the frames. */
export function animatedPng(frames = 3) {
  const control = Buffer.alloc(8);
  control.writeUInt32BE(frames, 0);
  return solidPng(8, 8, [200, 60, 60], [pngChunk("acTL", control)]);
}

/** A minimal uncompressed 24-bit BMP. */
export function solidBmp(width, height, [r, g, b] = [200, 120, 40]) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const out = Buffer.alloc(54 + pixelBytes);
  out.write("BM", 0, "latin1");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(pixelBytes, 34);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) out.set([b, g, r], 54 + y * rowSize + x * 3);
  return out;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
