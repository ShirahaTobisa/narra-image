import "server-only";

// 同一个邮箱 15 分钟内输错 10 次，就先锁到最早那次失败满 15 分钟。
// 进程内计数，单实例部署够用；重启清零也无妨。
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map<string, number[]>();

function recentFailures(email: string) {
  const since = Date.now() - WINDOW_MS;
  return (failures.get(email) ?? []).filter((at) => at > since);
}

export function isLoginLocked(email: string) {
  return recentFailures(email).length >= MAX_FAILURES;
}

export function recordLoginFailure(email: string) {
  // 有人拿大量随机邮箱乱试时，顺手清掉已过期的记录，内存不会一直涨
  if (failures.size > 10_000) {
    for (const key of failures.keys()) {
      if (recentFailures(key).length === 0) failures.delete(key);
    }
  }
  failures.set(email, [...recentFailures(email), Date.now()]);
}
