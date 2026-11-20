import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockEnv,
  mockHashPassword,
  mockInviteUpsert,
  mockRegisterUser,
  mockRequireTurnstile,
  mockTransaction,
} = vi.hoisted(() => ({
  mockEnv: {
    AUTH_SECRET: "unit-test-secret",
    BOOTSTRAP_ADMIN_EMAIL: "",
    BOOTSTRAP_INVITE_CODE: "",
  },
  mockHashPassword: vi.fn(),
  mockInviteUpsert: vi.fn(),
  mockRegisterUser: vi.fn(),
  mockRequireTurnstile: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    inviteCode: { findUnique: vi.fn(async () => ({ usedAt: null })), upsert: mockInviteUpsert },
    user: { count: vi.fn(async () => 0) },
    $transaction: mockTransaction,
  },
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => mockEnv,
}));

vi.mock("@/lib/auth/password", () => ({
  hashPassword: mockHashPassword,
}));

vi.mock("@/lib/auth/register-user", () => ({
  registerUser: mockRegisterUser,
}));

vi.mock("@/lib/auth/turnstile", () => ({
  requireTurnstile: mockRequireTurnstile,
}));

vi.mock("@/lib/auth/session", () => ({
  attachSessionCookie: vi.fn(),
}));

import { POST } from "@/app/api/auth/register/route";

describe("关闭公开邮箱注册", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.BOOTSTRAP_INVITE_CODE = "";
    mockHashPassword.mockResolvedValue("hashed-password");
    mockRegisterUser.mockResolvedValue({ ok: false, message: "邀请码已失效" });
    mockTransaction.mockImplementation(async (callback) => callback({}));
  });

  it("无邀请码时明确拒绝，不验证验证码或创建账号", async () => {
    const response = await POST();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: expect.stringContaining("Discord") });
    expect(mockInviteUpsert).not.toHaveBeenCalled();
    expect(mockRequireTurnstile).not.toHaveBeenCalled();
    expect(mockHashPassword).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("显式初始邀请码也不能重新开放公开邮箱注册", async () => {
    mockEnv.BOOTSTRAP_INVITE_CODE = "private-bootstrap-code";

    const response = await POST();
    expect(response.status).toBe(403);
    expect(mockInviteUpsert).not.toHaveBeenCalled();
    expect(mockRegisterUser).not.toHaveBeenCalled();
  });
});
