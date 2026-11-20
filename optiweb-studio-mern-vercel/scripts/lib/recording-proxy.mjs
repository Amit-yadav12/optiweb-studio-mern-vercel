/**
 * A forward proxy that the test browser is told to use for every connection,
 * loopback included. Whatever the browser sends (from pages, workers or the
 * browser itself) passes through here, so this log is the complete record of
 * the browser's network traffic during a test.
 *
 * Requests to the app under test are forwarded and measured. Requests to any
 * other host are refused and recorded: the tests assert that there are none.
 */
import { once } from "node:events";
import http from "node:http";

export async function startRecordingProxy({ origin }) {
  const target = new URL(origin);
  /** @type {Array<Record<string, any>>} */
  const log = [];
  let offline = false;

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      url = null;
    }
    const entry = {
      at: Date.now(),
      method: req.method,
      url: req.url,
      host: url?.host ?? req.headers.host ?? "",
      path: url ? `${url.pathname}${url.search}` : req.url,
      query: url?.search ?? "",
      contentType: req.headers["content-type"] ?? null,
      declaredLength: req.headers["content-length"] ? Number(req.headers["content-length"]) : 0,
      /** Bytes of request body that actually arrived. */
      bodyBytes: 0,
      /** The request body, kept so a test can look for a file's contents in it. */
      body: Buffer.alloc(0),
      /** Request headers, as one string, for the same reason. */
      headerText: Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join("\n"),
      cookieSent: Boolean(req.headers.cookie),
      status: null,
      setCookie: false,
      responseBytes: 0,
      refused: null,
    };
    log.push(entry);
    const chunks = [];
    req.on("data", (chunk) => {
      entry.bodyBytes += chunk.length;
      chunks.push(chunk);
    });
    req.on("end", () => {
      entry.body = Buffer.concat(chunks);
    });

    if (!url || url.host !== target.host) {
      entry.refused = "other-origin";
      req.resume();
      res.writeHead(502, { "content-type": "text/plain" }).end("The test proxy forwards only to the app under test.");
      return;
    }
    if (offline) {
      entry.refused = "offline";
      req.resume();
      res.writeHead(503, { "content-type": "text/plain" }).end("The test proxy is offline.");
      return;
    }
    const upstream = http.request({ host: target.hostname, port: target.port, method: req.method, path: entry.path, headers: { ...req.headers, host: target.host } }, (response) => {
      entry.status = response.statusCode;
      entry.setCookie = Boolean(response.headers["set-cookie"]);
      entry.responseHeaders = response.headers;
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.on("data", (chunk) => {
        entry.responseBytes += chunk.length;
      });
      response.pipe(res);
    });
    upstream.on("error", () => {
      entry.refused = "upstream-error";
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  // HTTPS and WebSocket tunnels: the app under test is plain HTTP on loopback, so any tunnel is traffic to somewhere else.
  server.on("connect", (req, socket) => {
    log.push({ at: Date.now(), method: "CONNECT", url: req.url, host: req.url, path: "", query: "", bodyBytes: 0, body: Buffer.alloc(0), headerText: "", status: null, refused: "other-origin", setCookie: false, cookieSent: false, responseBytes: 0, declaredLength: 0, contentType: null });
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  server.on("upgrade", (req, socket) => {
    log.push({ at: Date.now(), method: "UPGRADE", url: req.url, host: req.headers.host ?? "", path: req.url, query: "", bodyBytes: 0, body: Buffer.alloc(0), headerText: "", status: null, refused: "upgrade", setCookie: false, cookieSent: false, responseBytes: 0, declaredLength: 0, contentType: null });
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  return {
    port,
    log,
    /** Arguments that make Chromium send everything, loopback included, through this proxy. */
    browserArgs: [`--proxy-server=http://127.0.0.1:${port}`, "--proxy-bypass-list=<-loopback>", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--disable-domain-reliability", "--no-first-run", "--no-pings"],
    /** Position in the log, to read later what happened after this moment. */
    mark: () => log.length,
    since: (mark) => log.slice(mark),
    /** While offline, every request is refused: nothing can be fetched and nothing can be sent. */
    setOffline(value) {
      offline = value;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
