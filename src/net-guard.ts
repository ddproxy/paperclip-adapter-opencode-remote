import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class NetworkGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkGuardError";
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, includes cloud metadata services
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3], // multicast and reserved
];

/** True for loopback, private, link-local, metadata and other non-public addresses. */
export function isBlockedAddress(address: string): boolean {
  const lower = address.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const fromHex = hex ? [parseInt(hex[1]!, 16) >> 8, parseInt(hex[1]!, 16) & 255, parseInt(hex[2]!, 16) >> 8, parseInt(hex[2]!, 16) & 255].join(".") : null;
  const ip = mapped ? mapped[1]! : fromHex ?? lower;
  if (isIP(ip) === 4) {
    const n = ipv4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (isIP(ip) === 6) {
    return (
      ip === "::" ||
      ip === "::1" ||
      /^f[cd][0-9a-f]{2}:/.test(ip) || // fc00::/7 unique local
      /^fe[89ab][0-9a-f]:/.test(ip) // fe80::/10 link-local
    );
  }
  return true; // not an address we can reason about
}

/**
 * Refuses hosts that are, or resolve to, non-public addresses. Best effort:
 * the connection resolves the name again, so this does not stop DNS rebinding.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new NetworkGuardError(`Refusing to contact non-public address ${host}`);
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch (err) {
    throw new NetworkGuardError(`Cannot resolve ${host}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const blocked = addresses.find((a) => isBlockedAddress(a.address));
  if (blocked) {
    throw new NetworkGuardError(`Refusing to contact ${host}: it resolves to non-public address ${blocked.address}`);
  }
}
