import "server-only";

import { createRateLimiter } from "@/lib/server/rate-limit";

// 同一个邮箱 15 分钟内输错 10 次，就先锁到最早那次失败满 15 分钟
const failures = createRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });

export const isLoginLocked = (email: string) => failures.isLimited(email);
export const recordLoginFailure = (email: string) => failures.record(email);
