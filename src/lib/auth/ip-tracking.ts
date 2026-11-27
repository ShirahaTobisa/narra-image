import "server-only";

import { headers } from "next/headers";
import { after } from "next/server";
import { db } from "@/lib/db";
import { normalizeClientIp } from "@/lib/auth/client-ip";

const WRITE_INTERVAL_MS = 5 * 60_000;
const recent = new Map<string, number>();

/** Only the private app-facing proxy may set this header; never trust a client-supplied forwarding chain. */
export function recordUserIp(userId: string, requestHeaders: Pick<Headers, "get">): void {
  const ip = normalizeClientIp(requestHeaders.get("x-narra-client-ip"));
  if (!ip) return;
  const key = `${userId}:${ip}`;
  const now = Date.now();
  if (now - (recent.get(key) ?? -Infinity) < WRITE_INTERVAL_MS) return;
  if (recent.size >= 10_000) recent.delete(recent.keys().next().value!);
  recent.set(key, now);
  const failed = () => {
    if (recent.get(key) === now) recent.delete(key);
    console.error("[account-ip] IP record failed");
  };
  try {
    after(async () => {
      try {
        const seenAt = new Date(now);
        await db.$executeRaw`
          INSERT INTO "UserIpAddress" ("userId", "ipAddress", "firstSeenAt", "lastSeenAt")
          VALUES (${userId}, ${ip}::inet, ${seenAt}, ${seenAt})
          ON CONFLICT ("userId", "ipAddress") DO UPDATE SET
            "firstSeenAt" = LEAST("UserIpAddress"."firstSeenAt", EXCLUDED."firstSeenAt"),
            "lastSeenAt" = GREATEST("UserIpAddress"."lastSeenAt", EXCLUDED."lastSeenAt")`;
      } catch { failed(); }
    });
  } catch { failed(); }
}

export async function recordCurrentUserIp(userId: string): Promise<void> {
  try { recordUserIp(userId, await headers()); }
  catch { console.error("[account-ip] Request IP unavailable"); }
}
