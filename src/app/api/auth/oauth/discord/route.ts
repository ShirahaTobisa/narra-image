import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  buildDiscordAuthorizeUrl,
  getDiscordCallbackUrl,
  getDiscordConfig,
} from "@/lib/auth/discord-oauth";
import { getEnv } from "@/lib/env";

const OAUTH_STATE_COOKIE = "discord_oauth_state";
const OAUTH_INVITE_COOKIE = "discord_invite_code";

export async function GET(request: Request) {
  const isProduction = getEnv().NODE_ENV === "production";
  const config = await getDiscordConfig();
  if (!config || !config.isEnabled) {
    return NextResponse.json({ error: "Discord 登录未启用" }, { status: 400 });
  }

  const url = new URL(request.url);
  const inviteCode = url.searchParams.get("inviteCode")?.trim() || "";

  const state = randomUUID();
  const authorizeUrl = buildDiscordAuthorizeUrl(
    config.clientId,
    getDiscordCallbackUrl(),
    state,
    Boolean(config.allowedGuildId),
  );

  const response = NextResponse.redirect(authorizeUrl);

  // 存储 state 到 cookie 防 CSRF
  const cookieStore = await cookies();
  cookieStore.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    maxAge: 300,
    path: "/",
    sameSite: "lax",
    secure: isProduction,
  });

  // 邀请码只在没限定服务器、新用户首次登录时使用
  if (inviteCode) {
    cookieStore.set(OAUTH_INVITE_COOKIE, inviteCode, {
      httpOnly: true,
      maxAge: 600,
      path: "/",
      sameSite: "lax",
      secure: isProduction,
    });
  } else {
    cookieStore.delete(OAUTH_INVITE_COOKIE);
  }

  return response;
}
