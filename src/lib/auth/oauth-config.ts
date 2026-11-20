import "server-only";

import { db } from "@/lib/db";
import { parseDiscordGuildIds, PUBLIC_OAUTH_PROVIDER } from "@/lib/auth/access-policy";

export type OAuthProviderInfo = {
  type: string;
  displayName: string;
  clientId: string;
  clientSecret: string;
  allowedGuildId: string | null;
  isEnabled: boolean;
};

export async function getEnabledOAuthProviders() {
  const providers = await db.oAuthProvider.findMany({
    where: { isEnabled: true, type: PUBLIC_OAUTH_PROVIDER },
    select: {
      allowedGuildId: true,
      type: true,
      displayName: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // 登录和绑定必须配置群成员验证；后台仍可查看所有历史配置。
  return providers
    .filter(({ allowedGuildId }) => parseDiscordGuildIds(allowedGuildId).length > 0)
    .map(({ type, displayName }) => ({ type, displayName, inviteExempt: true }));
}

export async function getOAuthProvider(type: string): Promise<OAuthProviderInfo | null> {
  const provider = await db.oAuthProvider.findUnique({
    where: { type },
    select: {
      allowedGuildId: true,
      clientId: true,
      clientSecret: true,
      displayName: true,
      isEnabled: true,
      type: true,
    },
  });

  return provider;
}

export async function getAllOAuthProviders() {
  return db.oAuthProvider.findMany({
    select: {
      allowedGuildId: true,
      clientId: true,
      createdAt: true,
      displayName: true,
      id: true,
      isEnabled: true,
      type: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function upsertOAuthProvider(data: {
  type: string;
  displayName: string;
  clientId: string;
  clientSecret: string;
  isEnabled: boolean;
  /** undefined = 不改；空字符串 = 清除 */
  allowedGuildId?: string;
}) {
  const { allowedGuildId, ...rest } = data;
  const guild = allowedGuildId === undefined ? {} : { allowedGuildId: allowedGuildId || null };
  return db.oAuthProvider.upsert({
    where: { type: data.type },
    update: {
      clientId: data.clientId,
      ...(data.clientSecret ? { clientSecret: data.clientSecret } : {}),
      displayName: data.displayName,
      isEnabled: data.isEnabled,
      ...guild,
    },
    create: { ...rest, ...guild },
  });
}

export async function deleteOAuthProvider(type: string) {
  return db.oAuthProvider.delete({ where: { type } });
}
