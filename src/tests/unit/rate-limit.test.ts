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
});
