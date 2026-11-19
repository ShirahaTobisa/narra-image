import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isLoginLocked, recordLoginFailure } from "@/lib/auth/login-throttle";
import { registerSchema } from "@/lib/validators";

describe("注册不许用第三方登录的占位邮箱", () => {
  it.each(["123456789012345678@discord.oauth", "Tester@LINUXDO.OAUTH"])("%s 被拒", (email) => {
    expect(registerSchema.safeParse({ email, password: "12345678" }).success).toBe(false);
  });

  it("普通邮箱照常可以注册", () => {
    expect(registerSchema.safeParse({ email: "user@example.com", password: "12345678" }).success).toBe(true);
  });
});

describe("登录次数限制", () => {
  afterEach(() => vi.useRealTimers());

  it("同一邮箱 15 分钟内错 10 次就锁住，过了窗口自动解锁，不影响别的邮箱", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-19T00:00:00Z"));
    for (let i = 0; i < 9; i += 1) recordLoginFailure("admin@site.test");
    expect(isLoginLocked("admin@site.test")).toBe(false);
    recordLoginFailure("admin@site.test");
    expect(isLoginLocked("admin@site.test")).toBe(true);
    expect(isLoginLocked("other@site.test")).toBe(false);

    vi.setSystemTime(new Date("2026-11-19T00:15:01Z"));
    expect(isLoginLocked("admin@site.test")).toBe(false);
  });
});
