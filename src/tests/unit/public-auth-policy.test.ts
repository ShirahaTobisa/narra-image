import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachSession: vi.fn(),
  claimInvite: vi.fn(),
  currentUser: vi.fn(),
  findUser: vi.fn(),
  findProvider: vi.fn(),
  findProviders: vi.fn(),
  isLocked: vi.fn(),
  loginFailure: vi.fn(),
  turnstile: vi.fn(),
  updateUser: vi.fn(),
  verifyPassword: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {
  user: { findUnique: mocks.findUser, update: mocks.updateUser },
  oAuthProvider: { findUnique: mocks.findProvider, findMany: mocks.findProviders },
} }));
vi.mock("@/lib/auth/password", () => ({ verifyPassword: mocks.verifyPassword }));
vi.mock("@/lib/auth/login-throttle", () => ({
  isLoginLocked: mocks.isLocked, recordLoginFailure: mocks.loginFailure,
}));
vi.mock("@/lib/auth/session", () => ({ attachSessionCookie: mocks.attachSession }));
vi.mock("@/lib/auth/turnstile", () => ({ requireTurnstile: mocks.turnstile }));
vi.mock("@/lib/server/current-user", () => ({ getCurrentUserRecord: mocks.currentUser }));
vi.mock("@/lib/invites/claim-invite.server", () => ({ claimInviteFromBatch: mocks.claimInvite }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ APP_URL: "https://draw.example.com", NODE_ENV: "test" }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "state" }), set: vi.fn(), delete: vi.fn() }) }));

import { POST as login } from "@/app/api/auth/login/route";
import { POST as claim } from "@/app/api/invites/batches/[id]/claim/route";
import { GET as linuxdoAuthorize } from "@/app/api/auth/oauth/linuxdo/route";
import { GET as linuxdoCallback } from "@/app/api/auth/oauth/linuxdo/callback/route";
import { POST as unlinkDiscord } from "@/app/api/me/oauth/discord/unlink/route";
import { getEnabledOAuthProviders } from "@/lib/auth/oauth-config";

const admin = {
  avatarUrl: null, bannedAt: null, credits: 27, email: "admin@example.com", id: "admin-id",
  nickname: "Admin", oauthId: "discord-id", oauthProvider: "discord", passwordHash: "hash", role: "ADMIN", uid: 7,
};
function loginRequest(extra = {}) {
  return new Request("https://draw.example.com/api/auth/login", {
    method: "POST", body: JSON.stringify({ email: admin.email, password: "password123", turnstileToken: "verified", ...extra }),
  });
}

describe("Discord 公开准入与管理员密码恢复", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findUser.mockResolvedValue(admin);
    mocks.currentUser.mockResolvedValue(admin);
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.findProvider.mockResolvedValue({ isEnabled: true, type: "linuxdo", clientId: "id", clientSecret: "secret" });
    mocks.findProviders.mockResolvedValue([{ type: "discord", displayName: "Discord", allowedGuildId: "123" }]);
    vi.stubGlobal("fetch", vi.fn());
  });

  it("普通邮箱账号即使提交管理员标记且密码正确也不能登录", async () => {
    mocks.findUser.mockResolvedValue({ ...admin, role: "USER" });
    const response = await login(loginRequest({ admin: true, role: "ADMIN" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: expect.stringContaining("Discord") });
    expect(mocks.attachSession).not.toHaveBeenCalled();
  });

  it("管理员仍须通过验证码和密码校验才得到管理员会话", async () => {
    const response = await login(loginRequest());
    expect(response.status).toBe(200);
    expect(mocks.turnstile).toHaveBeenCalledWith("login", "verified");
    expect(mocks.verifyPassword).toHaveBeenCalledWith("password123", "hash");
    expect(mocks.attachSession).toHaveBeenCalledWith(expect.anything(), { role: "admin", userId: admin.id });
  });

  it("管理员密码错误仍累计失败且不建立会话", async () => {
    mocks.verifyPassword.mockResolvedValue(false);
    expect((await login(loginRequest())).status).toBe(401);
    expect(mocks.loginFailure).toHaveBeenCalledWith(admin.email);
    expect(mocks.attachSession).not.toHaveBeenCalled();
  });

  it("普通邮箱密码错误和未知邮箱均返回 401 并计入失败，不泄露角色差异", async () => {
    mocks.findUser.mockResolvedValueOnce({ ...admin, role: "USER" }).mockResolvedValueOnce(null);
    mocks.verifyPassword.mockResolvedValue(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await login(loginRequest());
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "邮箱或密码错误" });
    }
    expect(mocks.loginFailure).toHaveBeenCalledTimes(2);
    expect(mocks.attachSession).not.toHaveBeenCalled();
  });

  it("管理员验证码失败、限频或封禁都不能恢复登录", async () => {
    mocks.turnstile.mockRejectedValueOnce(new Error("人机验证失败"));
    expect((await login(loginRequest())).status).toBe(400);
    expect(mocks.findUser).not.toHaveBeenCalled();
    mocks.isLocked.mockReturnValueOnce(true);
    expect((await login(loginRequest())).status).toBe(429);
    mocks.findUser.mockResolvedValueOnce({ ...admin, bannedAt: new Date() });
    expect((await login(loginRequest())).status).toBe(403);
    expect(mocks.attachSession).not.toHaveBeenCalled();
  });

  it("公开领码接口直接关闭，不占用邀请码", async () => {
    const response = await claim();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: expect.stringContaining("Discord") });
    expect(mocks.claimInvite).not.toHaveBeenCalled();
    expect(mocks.turnstile).not.toHaveBeenCalled();
  });

  it("即使数据库启用 LinuxDo，授权和回调也拒绝且不发网络请求", async () => {
    for (const handler of [linuxdoAuthorize, linuxdoCallback]) {
      const response = await handler();
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: expect.stringContaining("Discord") });
    }
    expect(mocks.findProvider).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.attachSession).not.toHaveBeenCalled();
  });

  it("公开和绑定入口的查询只允许 Discord", async () => {
    expect(await getEnabledOAuthProviders()).toEqual([{ type: "discord", displayName: "Discord", inviteExempt: true }]);
    expect(mocks.findProviders).toHaveBeenCalledWith(expect.objectContaining({ where: { isEnabled: true, type: "discord" } }));
  });

  it("未配置群验证的 Discord 不显示为可用登录或绑定入口", async () => {
    mocks.findProviders.mockResolvedValue([{ type: "discord", displayName: "Discord", allowedGuildId: " , \n" }]);
    expect(await getEnabledOAuthProviders()).toEqual([]);
  });

  it("普通用户即使有密码也不能解绑唯一可用的 Discord", async () => {
    mocks.currentUser.mockResolvedValue({ ...admin, role: "USER" });
    expect((await unlinkDiscord()).status).toBe(403);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("有密码的管理员可以解绑，管理员无密码仍被拒绝", async () => {
    expect((await unlinkDiscord()).status).toBe(200);
    expect(mocks.updateUser).toHaveBeenCalledWith({ where: { id: admin.id }, data: { oauthId: null, oauthProvider: null } });
    mocks.updateUser.mockClear();
    mocks.findUser.mockResolvedValue({ ...admin, passwordHash: null });
    expect((await unlinkDiscord()).status).toBe(400);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});
