import "server-only";

/**
 * 进程内按时间窗口记次数：同一个 key 在 windowMs 内最多 limit 次。
 * 单实例部署够用；重启清零也无妨。
 */
export function createRateLimiter({ limit, windowMs }: { limit: number; windowMs: number }) {
  const hits = new Map<string, number[]>();
  const recent = (key: string) => {
    const since = Date.now() - windowMs;
    return (hits.get(key) ?? []).filter((at) => at > since);
  };

  return {
    isLimited: (key: string) => recent(key).length >= limit,
    record(key: string) {
      // 有人拿大量不同的 key 乱试时，顺手清掉已过期的记录，内存不会一直涨
      if (hits.size > 10_000) {
        for (const stale of hits.keys()) {
          if (recent(stale).length === 0) hits.delete(stale);
        }
      }
      hits.set(key, [...recent(key), Date.now()]);
    },
  };
}
