import { isIP } from "node:net";

export function normalizeClientIp(value: string | null): string | null {
  const ip = value?.trim();
  if (!ip || ip.includes("%") || !isIP(ip)) return null;
  if (isIP(ip) === 4) return ip;
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  return mapped
    ? mapped.slice(1).flatMap((part) => { const n = Number.parseInt(part, 16); return [n >>> 8, n & 255]; }).join(".")
    : canonical;
}
