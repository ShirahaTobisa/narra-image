import "server-only";

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeClientIp } from "@/lib/auth/client-ip";

const PAGE_SIZE = 20;

export async function getUserIpReport(input: { page?: number; sharedOnly?: boolean; ip?: string } = {}) {
  const ip = input.ip?.trim() ? normalizeClientIp(input.ip) : null;
  const invalidIp = Boolean(input.ip?.trim() && !ip);
  const where = invalidIp ? Prisma.sql`WHERE false` : ip ? Prisma.sql`WHERE "ipAddress" = ${ip}::inet` : Prisma.empty;
  const having = input.sharedOnly === false ? Prisma.empty : Prisma.sql`HAVING COUNT(*) > 1`;
  const [totals, coverage, totalUsers] = await Promise.all([
    db.$queryRaw<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM (
      SELECT 1 FROM "UserIpAddress" ${where} GROUP BY "ipAddress" ${having}) AS groups`,
    db.$queryRaw<{ count: number }[]>`SELECT COUNT(DISTINCT "userId")::int AS count FROM "UserIpAddress"`,
    db.user.count(),
  ]);
  const totalGroups = totals[0].count;
  const totalPages = Math.ceil(totalGroups / PAGE_SIZE);
  const page = Math.min(Math.max(1, Math.trunc(input.page ?? 1) || 1), Math.max(1, totalPages));
  const groups = await db.$queryRaw<{ ipAddress: string; userCount: number; firstSeenAt: Date; lastSeenAt: Date }[]>`
    SELECT host("ipAddress") AS "ipAddress", COUNT(*)::int AS "userCount",
      MIN("firstSeenAt") AS "firstSeenAt", MAX("lastSeenAt") AS "lastSeenAt"
    FROM "UserIpAddress" ${where} GROUP BY "ipAddress" ${having}
    ORDER BY MAX("lastSeenAt") DESC, "ipAddress" LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`;
  const records = groups.length ? await db.userIpAddress.findMany({
    where: { ipAddress: { in: groups.map((group) => group.ipAddress) } },
    select: { ipAddress: true, firstSeenAt: true, lastSeenAt: true,
      user: { select: { id: true, uid: true, nickname: true, oauthProvider: true, oauthId: true } } },
    orderBy: [{ lastSeenAt: "desc" }, { userId: "asc" }],
  }) : [];
  return { page, totalPages, totalGroups, trackedUsers: coverage[0].count, totalUsers, invalidIp,
    groups: groups.map((group) => ({ ...group, users: records.filter((record) => normalizeClientIp(record.ipAddress) === group.ipAddress)
      .map((record) => ({ userId: record.user.id, uid: record.user.uid, nickname: record.user.nickname,
        oauthProvider: record.user.oauthProvider, oauthId: record.user.oauthId,
        firstSeenAt: record.firstSeenAt, lastSeenAt: record.lastSeenAt })) })),
  };
}
