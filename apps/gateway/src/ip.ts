import { isIPv4, isIPv6 } from "node:net";

/**
 * Truncates an IP address so it no longer identifies a single connection.
 * IPv4 loses its last octet (a /24); IPv6 keeps only its first three groups
 * (a /48). The full address is never logged, stored or forwarded.
 *
 * @returns The truncated address, or `null` if the input is not an IP address.
 */
export function truncateIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith("::ffff:") && isIPv4(ip.slice(7))) ip = ip.slice(7);

  if (isIPv4(ip)) {
    const parts = ip.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (isIPv6(ip)) {
    const zone = ip.indexOf("%");
    if (zone !== -1) ip = ip.slice(0, zone);
    const groups = expandIpv6(ip);
    if (!groups) return null;
    return `${groups.slice(0, 3).join(":")}::`;
  }
  return null;
}

function expandIpv6(ip: string): string[] | null {
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - headGroups.length - tailGroups.length;
  if (tail === undefined ? headGroups.length !== 8 : missing < 0) return null;
  const fill = tail === undefined ? [] : new Array<string>(missing).fill("0");
  return [...headGroups, ...fill, ...tailGroups].map((g) => g.replace(/^0+(?=.)/, ""));
}

/**
 * Picks the client address for a request.
 *
 * Forwarding headers are trusted only when `trustProxy` is set, which is the
 * case behind the reverse proxy in the reference deployment. Otherwise anyone
 * could choose their own address.
 */
export function clientIp(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
  trustProxy: boolean,
): string | undefined {
  if (trustProxy) {
    const forwarded = headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(",")[0]?.trim();
    if (first) return first;
  }
  return socketAddress;
}
