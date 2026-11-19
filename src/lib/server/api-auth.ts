import "server-only";

import { after } from "next/server";

import { isApiEnabled } from "@/lib/api-config";
import { db } from "@/lib/db";
import { ApiAuthError } from "@/lib/api-errors";
import { hashApiKey } from "@/lib/api-keys";
import { fromPrismaRole } from "@/lib/prisma-mappers";

function readBearerToken(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const lastUsedCache = new Map<string, number>();

function shouldWriteLastUsed(apiKeyId: string, now: number) {
  const previous = lastUsedCache.get(apiKeyId);
  if (previous && now - previous < LAST_USED_WRITE_INTERVAL_MS) {
    return false;
  }
  lastUsedCache.set(apiKeyId, now);
  return true;
}

export async function requireApiUser(request: Request) {
  // 后台关了 API 就在最前面拒绝，免得关着还去下载请求里的图片
  if (!(await isApiEnabled())) {
    throw new ApiAuthError("站点 API 当前已关闭");
  }
  const token = readBearerToken(request);
  if (!token) {
    throw new ApiAuthError("缺少 Authorization: Bearer API_KEY");
  }

  const apiKey = await db.apiKey.findUnique({
    where: {
      keyHash: hashApiKey(token),
    },
    include: {
      user: {
        select: {
          avatarUrl: true,
          bannedAt: true,
          credits: true,
          email: true,
          id: true,
          nickname: true,
          role: true,
        },
      },
    },
  });

  if (!apiKey || apiKey.revokedAt || apiKey.user.bannedAt) {
    throw new ApiAuthError("API Key 无效或已停用");
  }

  const now = Date.now();
  if (shouldWriteLastUsed(apiKey.id, now)) {
    after(async () => {
      try {
        await db.apiKey.update({
          where: { id: apiKey.id },
          data: { lastUsedAt: new Date(now) },
        });
      } catch {
        lastUsedCache.delete(apiKey.id);
      }
    });
  }

  return {
    apiKey: {
      id: apiKey.id,
      keyPrefix: apiKey.keyPrefix,
      name: apiKey.name,
    },
    user: {
      ...apiKey.user,
      role: fromPrismaRole(apiKey.user.role),
    },
  };
}
