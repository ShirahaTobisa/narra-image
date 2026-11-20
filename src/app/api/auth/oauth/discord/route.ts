import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  buildDiscordAuthorizeUrl,
  getDiscordCallbackUrl,
  getDiscordConfig,
  parseDiscordGuildIds,
} from "@/lib/auth/discord-oauth";
import { DISCORD_GUILD_UNAVAILABLE_MESSAGE } from "@/lib/auth/access-policy";
import { getEnv } from "@/lib/env";

const OAUTH_STATE_COOKIE = "discord_oauth_state";
const OAUTH_INVITE_COOKIE = "discord_invite_code";

export async function GET() {
  const isProduction = getEnv().NODE_ENV === "production";
  const config = await getDiscordConfig();
  if (!config || !config.isEnabled) {
    return NextResponse.json({ error: "Discord 登录未启用" }, { status: 400 });
  }

  if (parseDiscordGuildIds(config.allowedGuildId).length === 0) {
    return NextResponse.json({ error: DISCORD_GUILD_UNAVAILABLE_MESSAGE }, { status: 503 });
  }

  const state = randomUUID();
  const authorizeUrl = buildDiscordAuthorizeUrl(
    config.clientId,
    getDiscordCallbackUrl(),
    state,
    true,
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

  cookieStore.delete(OAUTH_INVITE_COOKIE);

  return response;
}
