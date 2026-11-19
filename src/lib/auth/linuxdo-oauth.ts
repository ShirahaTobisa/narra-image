import "server-only";

import {
  findOrCreateOAuthAccount,
  linkOAuthAccount,
  unlinkOAuthAccount,
  type FindOrCreateOAuthResult,
  type LinkOAuthResult,
  type OAuthProfile,
  type UnlinkOAuthResult,
} from "@/lib/auth/oauth-accounts";
import { getOAuthProvider } from "@/lib/auth/oauth-config";
import { getEnv } from "@/lib/env";

const LINUXDO_AUTHORIZE_URL = "https://connect.linux.do/oauth2/authorize";
const LINUXDO_TOKEN_URL = "https://connect.linux.do/oauth2/token";
const LINUXDO_USER_URL = "https://connect.linux.do/api/user";

export type LinuxDoUser = {
  id: number;
  username: string;
  name: string;
  avatar_url: string;
  trust_level: number;
  active: boolean;
  silenced: boolean;
};

export function buildLinuxDoAuthorizeUrl(clientId: string, redirectUri: string, state: string) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });
  return `${LINUXDO_AUTHORIZE_URL}?${params.toString()}`;
}

export function getLinuxDoCallbackUrl() {
  return `${getEnv().APP_URL}/api/auth/oauth/linuxdo/callback`;
}

export async function exchangeLinuxDoToken(code: string, clientId: string, clientSecret: string, redirectUri: string) {
  const response = await fetch(LINUXDO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LinuxDo token exchange failed: ${response.status} ${text}`);
  }

  const data = await response.json() as { access_token: string; token_type: string };
  return data.access_token;
}

export async function fetchLinuxDoUser(accessToken: string): Promise<LinuxDoUser> {
  const response = await fetch(LINUXDO_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`LinuxDo user fetch failed: ${response.status}`);
  }

  return response.json() as Promise<LinuxDoUser>;
}

/**
 * 构建 LinuxDo 头像完整 URL
 * avatar_url 可能是完整 URL，也可能是 avatar_template 格式
 */
function buildAvatarUrl(avatarUrl: string): string {
  if (avatarUrl.startsWith("http")) {
    return avatarUrl;
  }
  // avatar_template 格式: /user_avatar/linux.do/username/{size}/xxx.png
  return `https://linux.do${avatarUrl.replace("{size}", "120")}`;
}

function linuxDoProfile(ldUser: LinuxDoUser): OAuthProfile {
  return {
    avatarUrl: ldUser.avatar_url ? buildAvatarUrl(ldUser.avatar_url) : null,
    name: ldUser.name,
    oauthId: String(ldUser.id),
    // 使用 linuxdo 用户名生成一个占位邮箱
    placeholderEmail: `${ldUser.username}@linuxdo.oauth`,
    provider: "linuxdo",
    username: ldUser.username,
  };
}

export type FindOrCreateOAuthInput = {
  ldUser: LinuxDoUser;
  inviteCode?: string | null;
};

export type { FindOrCreateOAuthResult };

export async function findOrCreateOAuthUser(
  input: FindOrCreateOAuthInput,
): Promise<FindOrCreateOAuthResult> {
  return findOrCreateOAuthAccount(linuxDoProfile(input.ldUser), { inviteCode: input.inviteCode });
}

export async function getLinuxDoConfig() {
  return getOAuthProvider("linuxdo");
}

export type LinkLinuxDoResult = LinkOAuthResult;

/** 以「已登录态」将 LinuxDo 账号绑定到当前用户 */
export async function linkLinuxDoAccount(input: {
  userId: string;
  ldUser: LinuxDoUser;
}): Promise<LinkLinuxDoResult> {
  return linkOAuthAccount(input.userId, linuxDoProfile(input.ldUser));
}

export type UnlinkLinuxDoResult = UnlinkOAuthResult;

/** 解绑 LinuxDo：纯 OAuth 注册账号（无密码）解绑后将无法登录，禁止解绑。 */
export async function unlinkLinuxDoAccount(
  userId: string,
): Promise<UnlinkLinuxDoResult> {
  return unlinkOAuthAccount(userId, "linuxdo");
}
