/**
 * SSRF controls for the website auditor.
 *
 * User-supplied URLs are resolved and checked *before* any socket is opened,
 * and again on every redirect hop. Private, loopback, link-local and metadata
 * addresses are rejected. This is a security boundary, not a convenience filter.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { badRequest } from "@/server/http/errors";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  const ranges: Array<[number, number]> = [
    [ipv4ToInt("0.0.0.0"), ipv4ToInt("0.255.255.255")],
    [ipv4ToInt("10.0.0.0"), ipv4ToInt("10.255.255.255")],
    [ipv4ToInt("100.64.0.0"), ipv4ToInt("100.127.255.255")],
    [ipv4ToInt("127.0.0.0"), ipv4ToInt("127.255.255.255")],
    [ipv4ToInt("169.254.0.0"), ipv4ToInt("169.254.255.255")],
    [ipv4ToInt("172.16.0.0"), ipv4ToInt("172.31.255.255")],
    [ipv4ToInt("192.0.0.0"), ipv4ToInt("192.0.0.255")],
    [ipv4ToInt("192.0.2.0"), ipv4ToInt("192.0.2.255")],
    [ipv4ToInt("192.168.0.0"), ipv4ToInt("192.168.255.255")],
    [ipv4ToInt("198.18.0.0"), ipv4ToInt("198.19.255.255")],
    [ipv4ToInt("198.51.100.0"), ipv4ToInt("198.51.100.255")],
    [ipv4ToInt("203.0.113.0"), ipv4ToInt("203.0.113.255")],
    [ipv4ToInt("224.0.0.0"), ipv4ToInt("255.255.255.255")],
  ];
  return ranges.some(([from, to]) => n >= from && n <= to);
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80") || lower.startsWith("ff")) return true;
  // IPv6 documentation prefix; it must not be treated as a public target.
  if (lower.startsWith("2001:db8:")) return true;
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    if (isIP(mapped) === 4) return isPrivateIPv4(mapped);
  }
  return false;
}

export function assertPublicIp(ip: string): void {
  const version = isIP(ip);
  if (version === 4 && isPrivateIPv4(ip)) {
    throw badRequest("That address is not a public website.", "Private, loopback and link-local hosts cannot be audited.");
  }
  if (version === 6 && isPrivateIPv6(ip)) {
    throw badRequest("That address is not a public website.", "Private, loopback and link-local hosts cannot be audited.");
  }
}

export async function assertPublicHostname(hostname: string): Promise<void> {
  const host = hostname.replace(/\.$/, "").toLowerCase();
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
