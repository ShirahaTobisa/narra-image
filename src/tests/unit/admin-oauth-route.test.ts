import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAll, mockUpsert } = vi.hoisted(() => ({ mockGetAll: vi.fn(), mockUpsert: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/current-user", () => ({ requireAdminRecord: vi.fn(async () => ({ id: "admin_1" })) }));
vi.mock("@/lib/auth/oauth-config", () => ({ getAllOAuthProviders: mockGetAll, upsertOAuthProvider: mockUpsert }));

import { POST } from "@/app/api/admin/oauth/route";

function discordAnswers(status: number, body: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

function save(clientSecret: string) {
  return POST(new Request("http://localhost/api/admin/oauth", {
    body: JSON.stringify({ clientId: "1380075940285124724", clientSecret, isEnabled: true, type: "discord" }),
    method: "POST",
  }));
}

describe("后台保存 Discord 登录源", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAll.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Discord 说 Client Secret 不对时不保存，直接提示", async () => {
    discordAnswers(401, { error: "invalid_client" });
    const response = await save("a".repeat(64));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("Client Secret") });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("Discord 认的 Client Secret 去掉首尾空格后保存", async () => {
    discordAnswers(200, { access_token: "token", token_type: "Bearer" });
    const response = await save(" Ab1_cD2-eF3gH4iJ5kL6mN7oP8qR9sT0 ");
    expect(response.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ clientSecret: "Ab1_cD2-eF3gH4iJ5kL6mN7oP8qR9sT0" }));
  });
});
