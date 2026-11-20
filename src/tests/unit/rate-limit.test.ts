import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createRateLimiter } from "@/lib/server/rate-limit";

describe("按时间窗口限次数", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("同一个用户一分钟内满 5 次就拦，换个用户不受影响，过了一分钟自动放开", () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
    for (let i = 0; i < 4; i += 1) limiter.record("user_1");
    expect(limiter.isLimited("user_1")).toBe(false);
    limiter.record("user_1");
    expect(limiter.isLimited("user_1")).toBe(true);
    expect(limiter.isLimited("user_2")).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(limiter.isLimited("user_1")).toBe(false);
  });

  it("整批原子计数，4 张后拒绝 2 张但仍可提交剩余 1 张", () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
    expect(limiter.tryRecord("user_1", 4)).toBe(true);
    expect(limiter.tryRecord("user_1", 2)).toBe(false);
    expect(limiter.tryRecord("user_1", 1)).toBe(true);
    expect(limiter.tryRecord("user_1")).toBe(false);
    expect(limiter.tryRecord("user_2", 5)).toBe(true);
  });

  it("每批额度在恰好 60 秒时过期，后续批次仍保留", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
    expect(limiter.tryRecord("user_1", 4)).toBe(true);
    vi.setSystemTime(10_000);
    expect(limiter.tryRecord("user_1")).toBe(true);
    vi.setSystemTime(59_999);
    expect(limiter.tryRecord("user_1")).toBe(false);
    vi.setSystemTime(60_000);
    expect(limiter.tryRecord("user_1", 4)).toBe(true);
    expect(limiter.tryRecord("user_1")).toBe(false);
    vi.setSystemTime(70_000);
    expect(limiter.tryRecord("user_1")).toBe(true);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 6, Number.MAX_SAFE_INTEGER + 1])(
    "非法或超额单位 %s 不占用或减少原有额度",
    (count) => {
      const limiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
      expect(limiter.tryRecord("user_1", count)).toBe(false);
      expect(limiter.tryRecord("user_1", 5)).toBe(true);
      expect(limiter.tryRecord("user_1", count)).toBe(false);
      expect(limiter.isLimited("user_1")).toBe(true);
    },
  );

  it("同时到达的请求最多接受 5 个单位", async () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      Promise.resolve().then(() => limiter.tryRecord("user_1"))));
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it("旧 record 与新原子计数使用相同窗口", () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
    limiter.record("user_1");
    expect(limiter.tryRecord("user_1", 4)).toBe(true);
    expect(limiter.isLimited("user_1")).toBe(true);
  });
});
