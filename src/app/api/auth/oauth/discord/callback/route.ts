import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { Role } from "@prisma/client";
import { DISCORD_GUILD_UNAVAILABLE_MESSAGE } from "@/lib/auth/access-policy";

import {
  discordProfile,
  exchangeDiscordToken,
  fetchDiscordUser,
  getDiscordCallbackUrl,
  getDiscordConfig,
  isDiscordGuildMember,
  parseDiscordGuildIds,
} from "@/lib/auth/discord-oauth";
import { findOrCreateOAuthAccount, linkOAuthAccount, oauthLoginErrorMessage } from "@/lib/auth/oauth-accounts";
import { attachSessionCookie, readSession } from "@/lib/auth/session";
import { getEnv } from "@/lib/env";
import { fromPrismaRole } from "@/lib/prisma-mappers";

const OAUTH_STATE_COOKIE = "discord_oauth_state";
const OAUTH_INVITE_COOKIE = "discord_invite_code";

export async function GET(request: Request) {
  const appUrl = getEnv().APP_URL;
  const loginError = (message: string) =>
    NextResponse.redirect(`${appUrl}/login?error=${encodeURIComponent(message)}`);

  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return loginError("缺少授权参数");
    }

    // 验证 state 防 CSRF，并清理旧版本留下的邀请码 cookie。
    const cookieStore = await cookies();
    const savedState = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
    cookieStore.delete(OAUTH_STATE_COOKIE);
    cookieStore.delete(OAUTH_INVITE_COOKIE);

    if (!savedState || savedState !== state) {
      return loginError("授权状态验证失败");
    }

    const config = await getDiscordConfig();
    if (!config || !config.isEnabled) {
      return loginError("Discord 登录未启用");
    }
    const guildIds = parseDiscordGuildIds(config.allowedGuildId);
    if (guildIds.length === 0) {
      return loginError(DISCORD_GUILD_UNAVAILABLE_MESSAGE);
    }

    const accessToken = await exchangeDiscordToken(
      code,
      config.clientId,
      config.clientSecret,
      getDiscordCallbackUrl(),
    );
    const discordUser = await fetchDiscordUser(accessToken);

    // 每次登录或绑定都验证指定服务器成员资格，邀请码不能替代。
    if (!(await isDiscordGuildMember(accessToken, guildIds))) {
      return loginError("请先加入指定的 Discord 服务器再登录");
    }

    const profile = discordProfile(discordUser);

    // 已登录态：把 Discord 绑定到当前账号（个人设置发起）
    const session = await readSession();
    if (session) {
      const linkResult = await linkOAuthAccount(session.userId, profile);
      if (!linkResult.ok) {
        if (linkResult.reason === "banned") {
          return loginError("账号已被封禁");
        }
        const message =
          linkResult.reason === "conflict"
            ? "该 Discord 账号已绑定其他 Narra 账号"
            : "绑定失败，请重试";
        return NextResponse.redirect(`${appUrl}/settings?error=${encodeURIComponent(message)}`);
      }
      return NextResponse.redirect(`${appUrl}/settings?linked=discord`);
    }

    // 未登录：群成员验证已通过，按 Discord 绑定查找或创建账号。
    const result = await findOrCreateOAuthAccount(profile, {
      inviteExempt: true,
    });
    if (!result.ok) {
      return loginError(oauthLoginErrorMessage(result.reason, "Discord"));
    }

    const response = NextResponse.redirect(`${appUrl}/create`);
    await attachSessionCookie(response, {
      role: fromPrismaRole(result.user.role as Role),
      userId: result.user.id,
    });
    return response;
  } catch {
    console.error("Discord OAuth callback failed");
    return loginError("第三方登录失败");
  }
}
