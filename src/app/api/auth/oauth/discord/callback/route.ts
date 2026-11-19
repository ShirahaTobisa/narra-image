import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { Role } from "@prisma/client";

import {
  discordProfile,
  exchangeDiscordToken,
  fetchDiscordUser,
  getDiscordCallbackUrl,
  getDiscordConfig,
  isDiscordGuildMember,
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

    // 验证 state 防 CSRF；同时取出邀请码并清理 cookie
    const cookieStore = await cookies();
    const savedState = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
    const inviteCode = cookieStore.get(OAUTH_INVITE_COOKIE)?.value || null;
    cookieStore.delete(OAUTH_STATE_COOKIE);
    cookieStore.delete(OAUTH_INVITE_COOKIE);

    if (!savedState || savedState !== state) {
      return loginError("授权状态验证失败");
    }

    const config = await getDiscordConfig();
    if (!config || !config.isEnabled) {
      return loginError("Discord 登录未启用");
    }

    const accessToken = await exchangeDiscordToken(
      code,
      config.clientId,
      config.clientSecret,
      getDiscordCallbackUrl(),
    );
    const discordUser = await fetchDiscordUser(accessToken);

    // 限定服务器时每次登录都查：被踢出服务器就登不进来
    if (config.allowedGuildId && !(await isDiscordGuildMember(accessToken, config.allowedGuildId))) {
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

    // 未登录：查找或创建用户（限定了服务器就免邀请码，否则新用户必须有有效邀请码）
    const result = await findOrCreateOAuthAccount(profile, {
      inviteCode,
      inviteExempt: Boolean(config.allowedGuildId),
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
  } catch (error) {
    console.error("Discord OAuth callback error:", error);
    return loginError("第三方登录失败");
  }
}
