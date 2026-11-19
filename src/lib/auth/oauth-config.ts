import "server-only";

import { db } from "@/lib/db";

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
    where: { isEnabled: true },
    select: {
      type: true,
      displayName: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return providers;
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
