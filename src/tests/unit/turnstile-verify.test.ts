import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindUnique } = vi.hoisted(() => ({ mockFindUnique: vi.fn() }));
const AUTH_SECRET = "test-auth-secret";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { turnstileConfig: { findUnique: mockFindUnique } } }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ APP_URL: "https://draw.example", AUTH_SECRET: "test-auth-secret" }) }));

import { verifyTurnstileToken } from "@/lib/auth/turnstile";
import { encryptProviderSecret } from "@/lib/providers/provider-secret";

function cloudflareAnswers(answer: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(answer))));
}

describe("登录时核对人机验证结果", () => {
  beforeEach(async () => {
    mockFindUnique.mockResolvedValue({ secretEncrypted: await encryptProviderSecret("0x4AAAAAAAsecret", AUTH_SECRET) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("在本站页面上完成的验证才算通过", async () => {
    cloudflareAnswers({ hostname: "draw.example", success: true });
    await expect(verifyTurnstileToken("token")).resolves.toEqual({ ok: true });
  });

  it("别的域名上完成的验证不认", async () => {
    cloudflareAnswers({ hostname: "localhost", success: true });
    await expect(verifyTurnstileToken("token")).resolves.toEqual({ ok: false, reason: "hostname-mismatch" });
  });
});
