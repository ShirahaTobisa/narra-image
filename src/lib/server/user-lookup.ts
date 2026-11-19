import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { parseUserUidQuery } from "@/lib/user-uid";

/** 用站内渠道出图时带给 OpenAI 的用户标识；算法必须和 Go Worker 的 safetyIdentifier 一致 */
export function openAiSafetyIdentifier(userId: string) {
  return createHash("sha256").update(`narra-user:${userId}`).digest("hex");
}

/**
 * 后台搜索词能直接定位到某个人时返回用户条件：#12 / 12 按编号，
 * 64 位十六进制按 OpenAI 用户标识（OpenAI 发警告时点名用的就是它）。返回 null 时照常模糊搜索。
 */
export async function exactUserWhere(query: string): Promise<Prisma.UserWhereInput | null> {
  const uid = parseUserUidQuery(query);
  if (uid) {
    return { uid };
  }
  const identifier = query.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(identifier)) {
    return null;
  }
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "User"
    WHERE encode(sha256(convert_to('narra-user:' || id, 'UTF8')), 'hex') = ${identifier}
    LIMIT 1`;
  return { id: rows[0]?.id ?? "" };
}
