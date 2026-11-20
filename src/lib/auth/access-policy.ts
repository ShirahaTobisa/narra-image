import "server-only";

import { Role } from "@prisma/client";

export const PUBLIC_OAUTH_PROVIDER = "discord";
export const DISCORD_ONLY_MESSAGE = "本站仅开放 Discord 登录，请使用指定服务器内的账号登录";
export const INVITE_REGISTRATION_CLOSED_MESSAGE = "邮箱注册与邀请码领取已关闭，请使用 Discord 登录";
export const DISCORD_GUILD_UNAVAILABLE_MESSAGE = "Discord 群成员验证暂未配置，请联系管理员";

export function canUsePasswordLogin(role: Role) {
  return role === Role.ADMIN;
}

/** 后台支持逗号、空格、换行分隔的服务器 ID。 */
export function parseDiscordGuildIds(value: string | null | undefined) {
  return [...new Set((value ?? "").split(/[\s,，、]+/).filter(Boolean))];
}
