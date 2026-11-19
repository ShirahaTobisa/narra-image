import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpdate } = vi.hoisted(() => ({ mockUpdate: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/server/current-user", () => ({ requireAdminRecord: vi.fn(async () => ({ id: "admin_1" })) }));
vi.mock("@/lib/auth/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/turnstile")>()),
  updateTurnstileConfig: mockUpdate,
}));

import { PATCH } from "@/app/api/admin/turnstile/route";

const SITE_KEY = "0x4AAAAAAAsitekey0000000";

function cloudflareSays(codes: string[]) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ "error-codes": codes, success: false }))));
}

function save(secretKey: string) {
  return PATCH(new Request("http://localhost/api/admin/turnstile", {
    body: JSON.stringify({ secretKey, siteKey: SITE_KEY }),
    method: "PATCH",
  }));
}

describe("后台保存 Turnstile 密钥", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({
      isEnabled: true,
      protectGenerate: false,
      protectInviteRedeem: true,
      protectLogin: true,
      protectRegister: true,
      secretEncrypted: "iv:data",
      siteKey: SITE_KEY,
      updatedAt: new Date(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Cloudflare 说 Secret Key 不对时不保存，直接提示", async () => {
    cloudflareSays(["invalid-input-secret"]);
    const response = await save(SITE_KEY);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("Secret Key") });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("Secret Key 没问题（只是假 token 不通过）就照常保存", async () => {
    cloudflareSays(["invalid-input-response"]);
    const response = await save("0x4AAAAAAAsecretkey0000000000000000");
    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ secretKey: "0x4AAAAAAAsecretkey0000000000000000" }));
  });
});
