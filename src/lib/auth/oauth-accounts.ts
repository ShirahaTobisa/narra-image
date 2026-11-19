import "server-only";

import { DEFAULT_INITIAL_CREDITS } from "@/lib/constants";
import { db } from "@/lib/db";

export type OAuthProviderType = "linuxdo" | "discord";

/** 各登录源把第三方用户整理成这份资料，再交给下面的通用账号逻辑 */
export type OAuthProfile = {
  avatarUrl: string | null;
  /** 显示名，可能为空 */
  name: string;
  oauthId: string;
  /** 新建账号时用的占位邮箱，也用于兼容「邮箱已存在但未绑定」的历史数据 */
  placeholderEmail: string;
  provider: OAuthProviderType;
  username: string;
};

const oauthUserSelect = {
  avatarUrl: true,
  bannedAt: true,
  credits: true,
  email: true,
  id: true,
  nickname: true,
  role: true,
} as const;

export type OAuthUser = {
  avatarUrl: string | null;
  credits: number;
  email: string;
  id: string;
  nickname: string | null;
  role: "USER" | "ADMIN";
};

export type FindOrCreateOAuthResult =
  | { ok: true; user: OAuthUser }
  | { ok: false; reason: "invite_required" | "invite_invalid" | "banned" | "conflict" };

/** 第三方登录失败时给用户看的提示 */
export function oauthLoginErrorMessage(
  reason: Extract<FindOrCreateOAuthResult, { ok: false }>["reason"],
  providerLabel: string,
) {
  switch (reason) {
    case "invite_required":
      return `首次使用 ${providerLabel} 登录需要填写邀请码`;
    case "banned":
      return "账号已被封禁";
    case "conflict":
      return "这个账号已被占用，请联系管理员";
    default:
      return "邀请码已失效";
  }
}

export async function findOrCreateOAuthAccount(
  profile: OAuthProfile,
  options: { inviteCode?: string | null; inviteExempt?: boolean },
): Promise<FindOrCreateOAuthResult> {
  const { avatarUrl, name, oauthId, provider } = profile;
  const inviteCode = options.inviteCode?.trim() || null;

  // 先查找已有 OAuth 绑定（老用户登录路径，跳过邀请码）
  const existingOAuth = await db.user.findFirst({
    where: {
      oauthProvider: provider,
      oauthId,
    },
    // 兼容历史脏数据：如果线上已经存在重复绑定，优先取最早的一条。
    orderBy: { createdAt: "asc" },
    select: oauthUserSelect,
  });

  if (existingOAuth) {
    if (existingOAuth.bannedAt) {
      return { ok: false, reason: "banned" };
    }
    const updated = await db.user.update({
      where: { id: existingOAuth.id },
      data: {
        ...(name && !existingOAuth.nickname ? { nickname: name } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
      },
      select: oauthUserSelect,
    });
    return { ok: true, user: updated as OAuthUser };
  }

  const email = profile.placeholderEmail;

  // 邮箱已存在但未绑定 OAuth：视作绑定路径，跳过邀请码（防御性兼容历史数据）
  const existingEmail = await db.user.findUnique({
    where: { email },
    select: { bannedAt: true, id: true, nickname: true, oauthId: true, passwordHash: true },
  });

  if (existingEmail) {
    if (existingEmail.bannedAt) {
      return { ok: false, reason: "banned" };
    }
    // 只接手"没密码、也没绑别的第三方号"的旧账号。有密码可能是别人抢注的占位邮箱，
    // 绑着别的号可能是改名前的旧用户名撞上了；这两种绑上去都等于把号交给了别人
    if (existingEmail.passwordHash || existingEmail.oauthId) {
      return { ok: false, reason: "conflict" };
    }
    const updated = await db.user.update({
      where: { id: existingEmail.id },
      data: {
        oauthProvider: provider,
        oauthId,
        ...(name && !existingEmail.nickname ? { nickname: name } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
      },
      select: oauthUserSelect,
    });
    return { ok: true, user: updated as OAuthUser };
  }

  const newUserData = {
    avatarUrl,
    credits: DEFAULT_INITIAL_CREDITS,
    email,
    nickname: name || profile.username,
    oauthId,
    oauthProvider: provider,
  };

  // 登录源已经做过准入（如 Discord 限定服务器成员）：直接建号，不要邀请码
  if (options.inviteExempt) {
    const newUser = await db.user.create({ data: newUserData, select: oauthUserSelect });
    return { ok: true, user: newUser as OAuthUser };
  }

  // 全新用户：必须有有效邀请码
  if (!inviteCode) {
    return { ok: false, reason: "invite_required" };
  }

  // 事务内先条件占用邀请码再创建用户：Read Committed 下事务包裹本身挡不住写覆盖，
  // 必须靠 updateMany 的 usedAt:null 条件保证并发下一码只进一人
  return db.$transaction(async (tx) => {
    const invite = await tx.inviteCode.findUnique({
      where: { code: inviteCode },
      select: { id: true, usedAt: true },
    });

    if (!invite || invite.usedAt) {
      return { ok: false as const, reason: "invite_invalid" as const };
    }

    const claimed = await tx.inviteCode.updateMany({
      where: { id: invite.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    if (claimed.count === 0) {
      return { ok: false as const, reason: "invite_invalid" as const };
    }

    const newUser = await tx.user.create({
      data: newUserData,
      select: oauthUserSelect,
    });

    await tx.inviteCode.update({
      where: { id: invite.id },
      data: { usedById: newUser.id },
    });

    return { ok: true as const, user: newUser as OAuthUser };
  });
}

export type LinkOAuthResult =
  | { ok: true }
  | { ok: false; reason: "unknown_user" | "banned" | "conflict" };

/**
 * 以「已登录态」把第三方账号绑定到当前用户：
 * - 该第三方账号已被其他账号绑定 → conflict；
 * - 当前账号已绑定同一第三方账号 → 幂等成功；
 * - 当前账号被封禁 → banned。
 */
export async function linkOAuthAccount(
  userId: string,
  profile: OAuthProfile,
): Promise<LinkOAuthResult> {
  const { avatarUrl, name, oauthId, provider } = profile;

  const target = await db.user.findUnique({
    where: { id: userId },
    select: { bannedAt: true, id: true, nickname: true },
  });
  if (!target) {
    return { ok: false, reason: "unknown_user" };
  }
  if (target.bannedAt) {
    return { ok: false, reason: "banned" };
  }

  const existing = await db.user.findFirst({
    where: { oauthId, oauthProvider: provider },
    select: { id: true },
  });
  if (existing) {
    if (existing.id === userId) {
      return { ok: true };
    }
    return { ok: false, reason: "conflict" };
  }

  await db.user.update({
    where: { id: userId },
    data: {
      oauthId,
      oauthProvider: provider,
      ...(name && !target.nickname ? { nickname: name } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
    },
  });

  return { ok: true };
}

export type UnlinkOAuthResult =
  | { ok: true }
  | { ok: false; reason: "unknown_user" | "not_linked" | "password_required" };

/** 解绑：纯 OAuth 注册账号（无密码）解绑后将无法登录，禁止解绑。 */
export async function unlinkOAuthAccount(
  userId: string,
  provider: OAuthProviderType,
): Promise<UnlinkOAuthResult> {
  const target = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      oauthId: true,
      oauthProvider: true,
      passwordHash: true,
    },
  });

  if (!target) {
    return { ok: false, reason: "unknown_user" };
  }
  if (target.oauthProvider !== provider) {
    return { ok: false, reason: "not_linked" };
  }
  if (!target.passwordHash) {
    return { ok: false, reason: "password_required" };
  }

  await db.user.update({
    where: { id: userId },
    data: { oauthId: null, oauthProvider: null },
  });

  return { ok: true };
}
