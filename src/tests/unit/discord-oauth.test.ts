import { beforeEach, describe, expect, it, vi } from "vitest";

const { cookieJar, mockAttachSession, mockDb, mockReadSession } = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(),
  mockAttachSession: vi.fn(),
  mockDb: {
    $transaction: vi.fn(),
    oAuthProvider: { findUnique: vi.fn() },
    user: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
  mockReadSession: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    delete: (name: string) => cookieJar.delete(name),
    get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined),
    set: (name: string, value: string) => cookieJar.set(name, value),
  }),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ APP_URL: "https://draw.example.com", NODE_ENV: "test" }),
}));
vi.mock("@/lib/auth/session", () => ({
  attachSessionCookie: mockAttachSession,
  readSession: mockReadSession,
}));

import { GET as callback } from "@/app/api/auth/oauth/discord/callback/route";
import { GET as authorize } from "@/app/api/auth/oauth/discord/route";
import { buildDiscordAuthorizeUrl, discordProfile, parseDiscordGuildIds } from "@/lib/auth/discord-oauth";

const GUILD_ID = "111122223333444455";
const DISCORD_USER = { avatar: "abc", global_name: "Alice", id: "123456789012345678", username: "alice" };

function providerConfig(allowedGuildId: string | null) {
  return {
    allowedGuildId,
    clientId: "client-id",
    clientSecret: "client-secret",
    displayName: "Discord",
    isEnabled: true,
    type: "discord",
  };
}

/** 假的 Discord 接口：换令牌、读用户、查服务器成员 */
function mockDiscordApi(member: { status: number; body?: unknown }) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "token" });
    if (url.endsWith("/users/@me")) return Response.json(DISCORD_USER);
    if (url.endsWith(`/users/@me/guilds/${GUILD_ID}/member`)) {
      return member.status === 404
        ? new Response("{}", { status: 404 })
        : Response.json(member.body ?? {}, { status: member.status });
    }
    // 其他服务器：都不是成员
    if (url.includes("/users/@me/guilds/")) return new Response("{}", { status: 404 });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

async function runCallback() {
  cookieJar.set("discord_oauth_state", "state-1");
  const response = await callback(
    new Request("https://draw.example.com/api/auth/oauth/discord/callback?code=code-1&state=state-1"),
  );
  return decodeURIComponent(response.headers.get("location") ?? "");
}

describe("Discord 登录", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieJar.clear();
    mockReadSession.mockResolvedValue(null);
    mockDb.user.findFirst.mockResolvedValue(null);
    mockDb.user.findUnique.mockResolvedValue(null);
    mockDb.user.create.mockImplementation(async ({ data }) => ({ ...data, bannedAt: null, id: "user_new", role: "USER" }));
  });

  it("只有限定服务器时才申请 guilds.members.read", () => {
    const plain = new URL(buildDiscordAuthorizeUrl("cid", "https://cb", "s", false));
    const gated = new URL(buildDiscordAuthorizeUrl("cid", "https://cb", "s", true));
    expect(plain.searchParams.get("scope")).toBe("identify");
    expect(gated.searchParams.get("scope")).toBe("identify guilds.members.read");
    expect(gated.searchParams.get("redirect_uri")).toBe("https://cb");
  });

  it("账号用不会变的数字 ID 识别，头像走 Discord CDN", () => {
    expect(discordProfile(DISCORD_USER)).toEqual({
      avatarUrl: "https://cdn.discordapp.com/avatars/123456789012345678/abc.png?size=128",
      name: "Alice",
      oauthId: "123456789012345678",
      placeholderEmail: "123456789012345678@discord.oauth",
      provider: "discord",
      username: "alice",
    });
  });

  it("state 对不上时直接拒绝，不请求 Discord", async () => {
    mockDb.oAuthProvider.findUnique.mockResolvedValue(providerConfig(null));
    global.fetch = vi.fn() as typeof fetch;
    cookieJar.set("discord_oauth_state", "another-state");

    const response = await callback(
      new Request("https://draw.example.com/api/auth/oauth/discord/callback?code=c&state=state-1"),
    );

    expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain("授权状态验证失败");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("限定服务器 ID 可以填多个，逗号、换行都行，重复的只算一次", () => {
    expect(parseDiscordGuildIds(` 111111111111111111，\n${GUILD_ID}, 111111111111111111 `)).toEqual(["111111111111111111", GUILD_ID]);
    expect(parseDiscordGuildIds(null)).toEqual([]);
  });

  it("限定多个服务器：是其中任意一个的成员就能登录", async () => {
    mockDb.oAuthProvider.findUnique.mockResolvedValue(providerConfig(`111111111111111111,${GUILD_ID}`));
    mockDiscordApi({ body: { pending: false }, status: 200 });

    expect(await runCallback()).toBe("https://draw.example.com/create");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/users/@me/guilds/111111111111111111/member"),
      expect.anything(),
    );
  });

  it("限定多个服务器：哪个都不是成员就不让登录", async () => {
    mockDb.oAuthProvider.findUnique.mockResolvedValue(providerConfig(`111111111111111111,${GUILD_ID}`));
    mockDiscordApi({ status: 404 });

    expect(await runCallback()).toContain("请先加入指定的 Discord 服务器再登录");
    expect(mockDb.user.create).not.toHaveBeenCalled();
  });

  it("限定服务器：不是成员就不让登录，也不查账号", async () => {
    mockDb.oAuthProvider.findUnique.mockResolvedValue(providerConfig(GUILD_ID));
    mockDiscordApi({ status: 404 });
    cookieJar.set("discord_invite_code", "legacy-valid-invite");

    const location = await runCallback();

    expect(location).toContain("/login?error=请先加入指定的 Discord 服务器再登录");
    expect(mockDb.user.findFirst).not.toHaveBeenCalled();
    expect(mockAttachSession).not.toHaveBeenCalled();
  });

  it("配置群限制时授权入口固定申请成员读取，清理旧邀请码并设置 state", async () => {
    mockDb.oAuthProvider.findUnique.mockResolvedValue(providerConfig(GUILD_ID));
    cookieJar.set("discord_invite_code", "legacy-invite");
    const response = await authorize();
    const target = new URL(response.headers.get("location")!);
    expect(target.origin).toBe("https://discord.com");
    expect(target.searchParams.get("scope")).toBe("identify guilds.members.read");
    expect(target.searchParams.get("state")).toBe(cookieJar.get("discord_oauth_state"));
    expect(cookieJar.has("discord_invite_code")).toBe(false);
  });

  it("限定服务器：还没通过入群验证（pending）也不算成员", async () => {
    mockDb.oAuthProvider.findUnique.mockResolvedValue(providerConfig(GUILD_ID));
    mockDiscordApi({ body: { pending: true }, status: 200 });

    expect(await runCallback()).toContain("请先加入指定的 Discord 服务器再登录");
    expect(mockDb.user.create).not.toHaveBeenCalled();
  });

  it("限定服务器：成员首次登录直接建号，不需要邀请码", async () => {
    mockDb.oAuthProvider.findUnique.mockResolvedValue(providerConfig(GUILD_ID));
    mockDiscordApi({ body: { pending: false }, status: 200 });

    const location = await runCallback();

    expect(location).toBe("https://draw.example.com/create");
    expect(mockDb.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "123456789012345678@discord.oauth",
          nickname: "Alice",
          oauthId: "123456789012345678",
          oauthProvider: "discord",
        }),
      }),
    );
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockAttachSession).toHaveBeenCalledWith(expect.anything(), { role: "user", userId: "user_new" });
  });

  it.each([null, " , \n，"])("未配置有效服务器 %s：即使有邀请码也拒绝授权与回调", async (guild) => {
    mockDb.oAuthProvider.findUnique.mockResolvedValue(providerConfig(guild));
    global.fetch = vi.fn() as typeof fetch;
    cookieJar.set("discord_invite_code", "valid-invite");

    const start = await authorize();
    expect(start.status).toBe(503);

    const location = await runCallback();

    expect(location).toContain("Discord 群成员验证暂未配置");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockAttachSession).not.toHaveBeenCalled();
  });

  it("已有 Discord 绑定登录原账号，更新资料不改积分", async () => {
    mockDb.oAuthProvider.findUnique.mockResolvedValue(providerConfig(GUILD_ID));
    mockDiscordApi({ body: { pending: false }, status: 200 });
    const original = { id: "original", role: "USER", bannedAt: null, nickname: "Saved", credits: 123 };
    mockDb.user.findFirst.mockResolvedValue(original);
    mockDb.user.update.mockResolvedValue(original);
    expect(await runCallback()).toBe("https://draw.example.com/create");
    expect(mockAttachSession).toHaveBeenCalledWith(expect.anything(), { role: "user", userId: "original" });
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockDb.user.update.mock.calls[0][0].data).not.toHaveProperty("credits");
  });

  it.each([null, "linuxdo"])("旧账号来源 %s 的有效会话可绑定 Discord，保留账号和积分且不新建用户", async (provider) => {
    mockDb.oAuthProvider.findUnique.mockResolvedValue(providerConfig(GUILD_ID));
    mockDiscordApi({ body: { pending: false }, status: 200 });
    mockReadSession.mockResolvedValue({ userId: "email-user", role: "user" });
    mockDb.user.findUnique.mockResolvedValue({ id: "email-user", bannedAt: null, nickname: "Existing", oauthProvider: provider });
    expect(await runCallback()).toBe("https://draw.example.com/settings?linked=discord");
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: "email-user" },
      data: { oauthId: DISCORD_USER.id, oauthProvider: "discord", avatarUrl: expect.any(String) },
    });
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockAttachSession).not.toHaveBeenCalled();
  });

  it("没有旧会话时不凭邮箱合并已有普通账号", async () => {
    mockDb.oAuthProvider.findUnique.mockResolvedValue(providerConfig(GUILD_ID));
    mockDiscordApi({ body: { pending: false }, status: 200 });
    mockDb.user.findUnique.mockResolvedValue({ id: "email-user", bannedAt: null, passwordHash: "existing-hash", oauthId: null });
    expect(await runCallback()).toContain("这个账号已被占用");
    expect(mockDb.user.update).not.toHaveBeenCalled();
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockAttachSession).not.toHaveBeenCalled();
  });
});
