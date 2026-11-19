import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAll, mockUpsert } = vi.hoisted(() => ({ mockGetAll: vi.fn(), mockUpsert: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/current-user", () => ({ requireAdminRecord: vi.fn(async () => ({ id: "admin_1" })) }));
vi.mock("@/lib/auth/oauth-config", () => ({ getAllOAuthProviders: mockGetAll, upsertOAuthProvider: mockUpsert }));

import { POST } from "@/app/api/admin/oauth/route";

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

  it("把 64 位的 Public Key 填进 Client Secret 时直接提示填错了", async () => {
    const response = await save("a".repeat(64));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("Public Key") });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("正常的 Client Secret 照常保存", async () => {
    const response = await save("Ab1_cD2-eF3gH4iJ5kL6mN7oP8qR9sT0");
    expect(response.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ clientSecret: "Ab1_cD2-eF3gH4iJ5kL6mN7oP8qR9sT0" }));
  });
});
