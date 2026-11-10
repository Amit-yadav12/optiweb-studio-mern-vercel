/**
 * Shared helpers for the storage self-tests: a check counter that also writes
 * GitHub annotations, and the API started inside the test process so the test
 * can read the server's log lines next to its responses.
 */
import { once } from "node:events";
import sharp from "sharp";

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
      const suffix = detail === "" || detail === undefined ? "" : ` — ${String(detail).slice(0, 400)}`;
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
    /** Reports a crash as a failed run instead of an unexplained exit. */
    crashed(error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      failures.push(`self-test crashed: ${reason}`);
      annotate("error", `self-test crashed after ${passed} passing checks: ${reason.slice(0, 400)}`);
      console.log(error);
      report();
    },
    report,
  };
}

/**
 * Starts the Express app in this process on a free local port.
 *
 * `console.error` is captured instead of printed, because it is the channel the
 * server logs on. `takeLogs()` returns the captured lines and the structured
 * storage entries among them, then clears the capture.
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
  const base = `http://127.0.0.1:${server.address().port}`;

  /** One request. Returns the raw body text as well, so a test can scan everything the client received. */
  async function call(path, { cookie, headers, ...init } = {}) {
    const response = await fetch(`${base}${path}`, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(headers ?? {}) } });
    const bytes = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "";
    const isText = /json|text|javascript|xml/.test(type);
    let json = null;
    if (type.includes("json")) {
      try { json = JSON.parse(bytes.toString("utf8")); } catch { json = null; }
    }
    const headerText = Array.from(response.headers.entries()).map(([key, value]) => `${key}: ${value}`).join("\n");
    return {
      status: response.status,
      headers: response.headers,
      bytes,
      json,
      /** Headers plus body (text bodies only): everything a browser could read from this response. */
      visible: `${headerText}\n${isText ? bytes.toString("utf8") : ""}`,
      sessionCookie: (response.headers.get("set-cookie") ?? "").split(";")[0] || null,
    };
  }

  function takeLogs() {
    const lines = captured.splice(0, captured.length);
    const entries = [];
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry.event === "string" && entry.event.startsWith("storage_")) entries.push(entry);
      } catch { /* not a structured line */ }
    }
    return { lines, entries, text: lines.join("\n") };
  }

  async function close() {
    console.error = originalError;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  return { base, call, takeLogs, close };
}

export async function pngImage(width, height, background) {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
}

/** A maximum-quality JPEG, which a WebP conversion reliably makes smaller. */
export async function jpegImage(width, height, background) {
  return sharp({ create: { width, height, channels: 3, background } }).jpeg({ quality: 100 }).toBuffer();
}

/** Multipart body for the image optimizer: `files` is a list of `{ name, data, type }`. */
export function imageForm(files, fields = {}) {
  const form = new FormData();
  for (const file of files) form.append("files", new Blob([file.data], { type: file.type ?? "image/png" }), file.name);
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  return form;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
