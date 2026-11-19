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

    const location = await runCallback();

    expect(location).toContain("/login?error=请先加入指定的 Discord 服务器再登录");
    expect(mockDb.user.findFirst).not.toHaveBeenCalled();
    expect(mockAttachSession).not.toHaveBeenCalled();
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

  it("未限定服务器：新用户没有邀请码时拒绝，也不查服务器成员", async () => {
    mockDb.oAuthProvider.findUnique.mockResolvedValue(providerConfig(null));
    mockDiscordApi({ status: 404 });

    const location = await runCallback();

    expect(location).toContain("首次使用 Discord 登录需要填写邀请码");
    const calledUrls = vi.mocked(global.fetch).mock.calls.map(([url]) => String(url));
    expect(calledUrls.some((url) => url.includes("/guilds/"))).toBe(false);
    expect(calledUrls.some((url) => url.endsWith("/users/@me"))).toBe(true);
    expect(mockDb.user.create).not.toHaveBeenCalled();
  });
});
