import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const limiters = globalThis as unknown as Record<symbol, unknown>;
const key = Symbol.for("narra.generation-rate-limit");

describe("共享用户图片限额", () => {
  beforeEach(() => {
    delete limiters[key];
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    delete limiters[key];
    vi.useRealTimers();
  });

  it("按用户接受 4+1 张，拒绝的 2 张不会占用余额", async () => {
    const { assertGenerationRateLimit } = await import("@/lib/server/generation-rate-limit");
    expect(() => assertGenerationRateLimit("user_1", 4)).not.toThrow();
    expect(() => assertGenerationRateLimit("user_1", 2)).toThrow("5 张");
    expect(() => assertGenerationRateLimit("user_1", 1)).not.toThrow();
    expect(() => assertGenerationRateLimit("user_1", 1)).toThrow(expect.objectContaining({ status: 429 }));
    expect(() => assertGenerationRateLimit("user_2", 5)).not.toThrow();
  });

  it("重载模块仍共享同一用户额度，恰好 60 秒后恢复", async () => {
    const first = await import("@/lib/server/generation-rate-limit");
    first.assertGenerationRateLimit("user_1", 4);
    vi.resetModules();
    const second = await import("@/lib/server/generation-rate-limit");
    expect(() => second.assertGenerationRateLimit("user_1", 2)).toThrow("5 张");
    expect(() => second.assertGenerationRateLimit("user_1", 1)).not.toThrow();
    vi.setSystemTime(59_999);
    expect(() => first.assertGenerationRateLimit("user_1", 1)).toThrow();
    vi.setSystemTime(60_000);
    expect(() => second.assertGenerationRateLimit("user_1", 5)).not.toThrow();
  });

  it("同一用户的并发调用不能超过 5 张", async () => {
    const { assertGenerationRateLimit } = await import("@/lib/server/generation-rate-limit");
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () =>
      Promise.resolve().then(() => assertGenerationRateLimit("user_1", 1))));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(5);
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(failures).toHaveLength(3);
    for (const failure of failures) expect(failure.reason).toMatchObject({ status: 429 });
  });

  it.each([0, -1, 0.5, NaN, Infinity, 6, Number.MAX_SAFE_INTEGER + 1])(
    "拒绝不合法的单位 %s，不能用于绕过或消耗限额",
    async (count) => {
      const { assertGenerationRateLimit } = await import("@/lib/server/generation-rate-limit");
      expect(() => assertGenerationRateLimit("user_1", count)).toThrow(expect.objectContaining({ status: 429 }));
      expect(() => assertGenerationRateLimit("user_1", 5)).not.toThrow();
    },
  );
});
