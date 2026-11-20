/**
 * Reads the log that Chrome keeps of its own network activity (started with
 * `--log-net-log=<file>`) and reports what it holds about given hosts.
 *
 * The recording proxy says that a request arrived. It cannot say who inside
 * the browser made it: a script of the page, or a service of the browser. The
 * browser's own log can: it names the kind of request, the full URL, whether it
 * was only a connection opened in advance, and the site it was made on behalf
 * of. The browser tests print this when the app's record holds a request to
 * another host, so that a failure explains itself.
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";

/** Parameters of a log event that identify a request and who asked for it. */
const TELLING = ["url", "original_url", "method", "is_preconnect", "num_streams", "traffic_annotation", "initiator", "network_anonymization_key", "network_isolation_key", "load_flags", "proxy_info", "net_error", "line"];

/**
 * The hash that Chromium stores in place of the name of a traffic annotation.
 * It allows checking a guess: `annotationHash("omnibox_zerosuggest")`.
 */
export function annotationHash(name) {
  let hash = name.charCodeAt(0);
  for (let index = 1; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) % 138003713;
  return hash;
}

/**
 * What the log holds about `hosts`: one line for each distinct kind of entry,
 * with how often it occurred. Returns an explanation instead when there is no
 * usable log.
 */
export async function explainHosts(path, hosts, { limit = 14 } = {}) {
  if (!path || !existsSync(path)) return ["the browser wrote no network log"];
  const sourceNames = new Map();
  /** One entry for each thing the browser's network stack worked on. @type {Map<number, { type: string, facts: Record<string, unknown>, mentions: boolean }>} */
  const sources = new Map();
  let first = true;

  for await (const raw of createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })) {
    if (first) {
      // The first line holds the tables that give the numbers in every later line their names.
      first = false;
      try {
        const { constants } = JSON.parse(`${raw.replace(/,\s*$/, "")}}`);
        for (const [name, id] of Object.entries(constants.logSourceType ?? {})) sourceNames.set(id, name);
      } catch {
        return ["the browser's network log could not be read"];
      }
      continue;
    }
    const line = raw.replace(/,\s*$/, "");
    if (!line.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a line cut short when the browser stopped
    }
    const id = event.source?.id;
    if (typeof id !== "number") continue;
    let source = sources.get(id);
    if (!source) {
      source = { type: sourceNames.get(event.source.type) ?? String(event.source.type), facts: {}, mentions: false };
      sources.set(id, source);
    }
    const params = event.params;
    if (!params || typeof params !== "object") continue;
    if (!source.mentions && hosts.some((host) => line.includes(host))) source.mentions = true;
    for (const key of TELLING) {
      if (params[key] !== undefined && source.facts[key] === undefined) source.facts[key] = typeof params[key] === "string" ? params[key].trim() : params[key];
    }
  }
  if (sources.size === 0) return ["the browser's network log is empty"];

  const describe = (source) => {
    const facts = Object.entries(source.facts).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    return `${source.type} ${facts.join(" ")}`.replace(/\s+/g, " ").trim();
  };
  // A request (URL_REQUEST) says what was asked and by whom. The entry that
  // picks a connection for it (HTTP_STREAM_JOB_CONTROLLER) says through which
  // proxy, and whether it was only a connection opened in advance. The entries
  // below those (sockets, handshakes) repeat the host and add nothing.
  const TOP = ["URL_REQUEST", "HTTP_STREAM_JOB_CONTROLLER"];
  const mentioned = [...sources.values()].filter((source) => source.mentions);
  if (mentioned.length === 0) return [`the browser's network log does not mention ${hosts.join(", ")}`];
  const shown = mentioned.some((source) => TOP.includes(source.type)) ? mentioned.filter((source) => TOP.includes(source.type)) : mentioned;
  const kinds = new Map();
  for (const source of shown) {
    const summary = describe(source).slice(0, 700);
    kinds.set(summary, (kinds.get(summary) ?? 0) + 1);
  }
  return [...kinds.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([summary, count]) => `${count}× ${summary}`);
}
