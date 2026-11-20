# 核心计费与网页 / Canvas 独立审阅

2026-11-21，trellis-check。在实现代理确认 route 定稿后只读审阅 `credits.ts`、`server/rate-limit.ts`、`server/generation-rate-limit.ts`、`api/generate/route.ts` 及对应测试；未编辑他人文件。

## 结论

未发现本轮修改产生的阻塞问题，无需添加额外计费或限流分支。共享额度按设计仅覆盖当前单应用进程，重启重置；不能视为多实例共享存储。

## 已核对边界

- `credits.ts:17` 仅文生图保留 count，其余类型为 1；按张费用与余额判断都接收同一个必填 count。视频仍取视频单价、自填渠道仍为零积分。全仓生产调用已传入 count，没有残留省略参数的调用。
- `server/rate-limit.ts:28` 的检查与记账是一个无 await 的同步操作。非法数值、零、负数、小数及超额请求不写入窗口；检查通过后才分配最多 limit 个时间戳。60 秒边界按原窗口定义过期，旧 record/isLimited 行为保持原义。
- `server/generation-rate-limit.ts:9` 每次读取固定 global Symbol，模块重复加载仍共享同一用户额度；以 userId 而非 API Key 作键。不同入口使用同一模块与键，超过 5 张抛稳定 ApiRateLimitError 429。
- 网页 `route.ts:107` 的 Canvas reserve / replay 先于图片额度检查；COMMITTED 或 PREPARING replay 不重记图片额度。关闭的功能也先拒绝。旧请求次数防刷保留为独立早期规则，没有把它误称为图片额度。
- `route.ts:118` 只解析一次实际张数，额度在验证码、原图读取、审核、输出预留和扣费前检查；后续费用、余额、预留和任务字段一致。普通文生图 4 × 5 = 20，图生图即使请求 count 4 也只写入 1。
- 普通 429 原样返回。Canvas 超额先按已有租约规则拒绝准备记录，再返回 private/no-store 429；如果无法确认拒绝，沿用既有只读恢复，不把未知状态当作已清理。原事务与退款分支未扩展；数据库余额条件仍为完整费用，写任务和扣费处于原同一事务。
- 新测试保持真实计费和 tryRecord；仅替换旧请求次数防刷，避免它掩盖图片额度测试。覆盖并发 4+4 仅接受一次、网页 4 后 Canvas 2 拒绝且剩余 1 可用、Canvas 2 张重放后仍可新提交 3 张。

## 独立验证

```text
node node_modules/vitest/vitest.mjs run src/tests/unit/credits.test.ts src/tests/unit/rate-limit.test.ts src/tests/unit/generation-rate-limit.test.ts src/tests/unit/generate-route-security.test.ts src/tests/unit/canvas-generate-route.test.ts --maxWorkers=2
```

5 suites / 115 tests 通过。此为核心与真实路由调用的隔离单测；Canvas DB 由测试状态模型模拟，没有访问实际 PostgreSQL。未扩大全量检查，全量类型、lint、构建和发布由主代理统一执行。
