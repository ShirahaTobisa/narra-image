import "server-only";

import type { OAuthProfile } from "@/lib/auth/oauth-accounts";
import { getOAuthProvider } from "@/lib/auth/oauth-config";
import { getEnv } from "@/lib/env";

const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const DISCORD_API_URL = "https://discord.com/api/v10";

export type DiscordUser = {
  avatar: string | null;
  global_name: string | null;
  id: string;
  username: string;
};

/** 限定服务器时才多要 guilds.members.read，用来查「我在这个服务器里的成员资料」 */
export function buildDiscordAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  checkGuild: boolean,
) {
  const params = new URLSearchParams({
    client_id: clientId,
    prompt: "none",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: checkGuild ? "identify guilds.members.read" : "identify",
    state,
  });
  return `${DISCORD_AUTHORIZE_URL}?${params.toString()}`;
}

export function getDiscordCallbackUrl() {
  return `${getEnv().APP_URL}/api/auth/oauth/discord/callback`;
}

export async function exchangeDiscordToken(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
) {
  const response = await fetch(`${DISCORD_API_URL}/oauth2/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Discord token exchange failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const response = await fetch(`${DISCORD_API_URL}/users/@me`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Discord user fetch failed: ${response.status}`);
  }

  return response.json() as Promise<DiscordUser>;
}

/** 后台填的限定服务器 ID：逗号、空格、换行都能隔开（库里存成逗号连起来的一串） */
export function parseDiscordGuildIds(value: string | null | undefined) {
  return [...new Set((value ?? "").split(/[\s,，、]+/).filter(Boolean))];
}

/**
 * 当前用户是不是其中任意一个服务器的正式成员：404 = 不在这个服务器；
 * pending = 还没通过服务器的入群验证，也不算。其他错误直接抛出（登录失败，不放行）。
 */
export async function isDiscordGuildMember(accessToken: string, guildIds: string[]) {
  for (const guildId of guildIds) {
    const response = await fetch(
      `${DISCORD_API_URL}/users/@me/guilds/${encodeURIComponent(guildId)}/member`,
      { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } },
    );

    if (response.status === 404) {
      continue;
    }
    if (!response.ok) {
      throw new Error(`Discord guild member check failed: ${response.status}`);
    }

    const member = (await response.json()) as { pending?: boolean };
    if (member.pending !== true) {
      return true;
    }
  }
  return false;
}

export function discordProfile(user: DiscordUser): OAuthProfile {
  return {
    avatarUrl: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
      : null,
    name: user.global_name ?? "",
    oauthId: user.id,
    // 用户名可以改，占位邮箱用不变的数字 ID
    placeholderEmail: `${user.id}@discord.oauth`,
    provider: "discord",
    username: user.username,
  };
}

export async function getDiscordConfig() {
  return getOAuthProvider("discord");
}
