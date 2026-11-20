import "server-only";

import { ApiRateLimitError } from "@/lib/api-errors";
import { createRateLimiter } from "@/lib/server/rate-limit";

const LIMITER_KEY = Symbol.for("narra.generation-rate-limit");

/** 同一应用进程的网页、Canvas 和 API 按用户共享；重启后清零。 */
export function assertGenerationRateLimit(userId: string, count: number): void {
  const limiters = globalThis as unknown as Record<symbol, ReturnType<typeof createRateLimiter> | undefined>;
  const limiter = limiters[LIMITER_KEY] ??= createRateLimiter({ limit: 5, windowMs: 60_000 });
  if (!limiter.tryRecord(userId, count)) {
    throw new ApiRateLimitError("请求太频繁：每个用户每分钟最多生成 5 张图片，请稍后再试");
  }
}
