/**
 * SSRF controls for the website auditor.
 *
 * User-supplied URLs are resolved and checked *before* any socket is opened,
 * and again on every redirect hop. Private, loopback, link-local and metadata
 * addresses are rejected. This is a security boundary, not a convenience filter.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { badRequest } from "../http/errors.js";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);

/**
 * Every address range that is not the public internet. `BlockList` compares
 * addresses as numbers, so no way of writing an address gets past it, and it
 * checks an IPv4 address wrapped in IPv6 (`::ffff:127.0.0.1`, `::ffff:7f00:1`)
 * against the IPv4 ranges.
 */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata services
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 3], // multicast, reserved, broadcast
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64: an IPv4 address in disguise
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: an IPv4 address in disguise
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, "ipv6");
}

/** Throws unless `ip` is an address on the public internet. Anything that is not an IP address is refused. */
export function assertPublicIp(ip: string): void {
  const version = isIP(ip);
  if (version === 0 || NOT_PUBLIC.check(ip, version === 4 ? "ipv4" : "ipv6")) {
    throw badRequest("That address is not a public website.", "Private, loopback and link-local hosts cannot be audited.");
  }
}

export async function assertPublicHostname(hostname: string): Promise<void> {
  // A URL writes an IPv6 address in brackets: [::1].
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw badRequest("That host cannot be audited.");
  }
  if (isIP(host)) {
    assertPublicIp(host);
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw badRequest(`Could not resolve “${host}”.`, "Check the URL and try again.");
  }
  if (records.length === 0) throw badRequest(`Could not resolve “${host}”.`);
  for (const record of records) assertPublicIp(record.address);
}

export function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest("Enter a valid http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest("Only http and https URLs are accepted.");
  }
  if (url.username || url.password) {
    throw badRequest("URLs with embedded credentials are not accepted.");
  }
  return url;
}

export async function validateAuditUrl(raw: string): Promise<URL> {
  const url = parseHttpUrl(raw);
  await assertPublicHostname(url.hostname);
  return url;
}
