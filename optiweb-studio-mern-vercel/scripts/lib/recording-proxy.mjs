/**
 * Two forward proxies for the browser tests, with one record each.
 *
 *   The app's proxy      Used by the one browser context in which the app runs.
 *                        Everything that context sends passes through it: its
 *                        pages, its workers, beacons, loopback included.
 *                        Requests to the app under test are forwarded and
 *                        measured. Requests to any other host are refused and
 *                        recorded: the tests assert that there are none.
 *
 *   The browser's proxy  Used by everything else in the browser process. A full
 *                        Google Chrome calls its maker's services on its own
 *                        (a time service, account and autofill services,
 *                        connections kept warm to the search engine), whatever
 *                        page is open. Those calls are not the app's. They are
 *                        refused here, so nothing leaves the machine, and
 *                        recorded, so a run can say what the browser tried.
 *
 * Why two: one proxy for the whole process cannot tell who sent a request, and
 * a list of "hosts the browser may call" would excuse the app as well. The
 * browser keeps the two apart by itself: a browser context has its own network
 * stack, and a proxy set on the context applies to that context only.
 */
import { once } from "node:events";
import http from "node:http";

/** Switches that turn off the browser's own network services, as far as it documents any. */
const QUIET = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-default-apps",
  "--disable-domain-reliability",
  "--no-first-run",
  "--no-pings",
  // Chrome asks a Google server about the fields of every form it sees, from
  // the network stack of the page that holds the form. It is the one service of
  // the browser that would show up in the app's record, so it is turned off.
  "--disable-features=AutofillServerCommunication,CertificateTransparencyComponentUpdater",
];

function blankEntry(fields) {
  return { at: Date.now(), method: "", url: "", host: "", path: "", query: "", contentType: null, declaredLength: 0, bodyBytes: 0, body: Buffer.alloc(0), headerText: "", cookieSent: false, status: null, setCookie: false, responseBytes: 0, refused: null, ...fields };
}

/**
 * One listening proxy that appends to `log`.
 * `forwardTo` is the only origin it forwards to; with null it refuses everything.
 */
async function listen({ log, forwardTo, isOffline }) {
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      url = null;
    }
    const entry = blankEntry({
      method: req.method,
      url: req.url,
      host: url?.host ?? req.headers.host ?? "",
      path: url ? `${url.pathname}${url.search}` : req.url,
      query: url?.search ?? "",
      contentType: req.headers["content-type"] ?? null,
      declaredLength: req.headers["content-length"] ? Number(req.headers["content-length"]) : 0,
      /** Request headers, as one string, so a test can look for a file's name in them. */
      headerText: Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join("\n"),
      cookieSent: Boolean(req.headers.cookie),
    });
    log.push(entry);
    // The request body is kept, so a test can look for a file's contents in it.
    const chunks = [];
    req.on("data", (chunk) => {
      entry.bodyBytes += chunk.length;
      chunks.push(chunk);
    });
    req.on("end", () => {
      entry.body = Buffer.concat(chunks);
    });

    if (!forwardTo || !url || url.host !== forwardTo.host) {
      entry.refused = "other-origin";
      req.resume();
      res.writeHead(502, { "content-type": "text/plain" }).end("The test proxy forwards only to the app under test.");
      return;
    }
    if (isOffline()) {
      entry.refused = "offline";
      req.resume();
      res.writeHead(503, { "content-type": "text/plain" }).end("The test proxy is offline.");
      return;
    }
    const upstream = http.request({ host: forwardTo.hostname, port: forwardTo.port, method: req.method, path: entry.path, headers: { ...req.headers, host: forwardTo.host } }, (response) => {
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

  // HTTPS and WebSocket tunnels: the app under test is plain HTTP on loopback,
  // so a tunnel is always traffic to somewhere else. It is refused before any
  // payload is exchanged.
  server.on("connect", (req, socket) => {
    log.push(blankEntry({ method: "CONNECT", url: req.url, host: req.url, refused: "other-origin" }));
    socket.on("error", () => undefined);
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  server.on("upgrade", (req, socket) => {
    log.push(blankEntry({ method: "UPGRADE", url: req.url, host: req.headers.host ?? "", path: req.url, refused: "upgrade" }));
    socket.on("error", () => undefined);
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

export async function startRecordingProxy({ origin }) {
  const target = new URL(origin);
  /** What the app's browser context sent. @type {Array<Record<string, any>>} */
  const log = [];
  /** What the rest of the browser sent on its own. @type {Array<Record<string, any>>} */
  const browserLog = [];
  let offline = false;

  const appProxy = await listen({ log, forwardTo: target, isOffline: () => offline });
  const browserProxy = await listen({ log: browserLog, forwardTo: null, isOffline: () => false });
  const address = (server) => `http://127.0.0.1:${server.address().port}`;
  // Chromium connects to loopback addresses directly unless told otherwise.
  const NO_BYPASS = "<-loopback>";

  return {
    log,
    browserLog,
    /** The two addresses, for telling the proxies apart in the browser's own log. */
    addresses: { app: address(appProxy).replace("http://", ""), browser: address(browserProxy).replace("http://", "") },
    /** Switches for starting the browser: its own traffic goes to the browser's proxy. */
    browserArgs: [`--proxy-server=${address(browserProxy)}`, `--proxy-bypass-list=${NO_BYPASS}`, ...QUIET],
    /** Options for `browser.createBrowserContext()`: the context in which the app runs sends everything through the app's proxy. */
    contextOptions: { proxyServer: address(appProxy), proxyBypassList: [NO_BYPASS] },
    /** Position in the app's record, to read later what happened after this moment. */
    mark: () => log.length,
    since: (mark) => log.slice(mark),
    /** While offline, every request of the app is refused: nothing can be fetched and nothing can be sent. */
    setOffline(value) {
      offline = value;
    },
    async close() {
      for (const server of [appProxy, browserProxy]) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
