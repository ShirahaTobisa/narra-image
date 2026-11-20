# 按张计费与共享限额核心

2026-11-21，trellis-implement。仅读写本次分配的 `credits.ts`、`server/rate-limit.ts`、新增 `server/generation-rate-limit.ts` 及三套核心单测；没有编辑调用方、依赖或生产配置，没有提交/推送/生产操作。已读取 PRD/design/implement、implement.jsonl 及引用规范。

## 改动与接口

- `resolveGenerationCount({ generationType, count })`：`text_to_image` 使用请求的合法批次数，其余图生图/视频均为 1。保持请求 schema 原有1～4边界，核心函数不重复维护另一套参数 schema。
- `calculateGenerationCost` 和 `hasEnoughCredits` 的 `count` 变为必填，表示实际输出数。内置渠道按单价×count计算，自填渠道仍为0；视频先选视频单价，再以实际数量1计费。旧实现未乘张数，4张单价5会只收5；现在返回20，余额19不足、20足够。
- `createRateLimiter` 保留 `isLimited/record`，增加同步 `tryRecord(key, count=1): boolean`。同一调用内检查及写入完整批次，超额不消费任何单位；零、负数、小数、NaN、Infinity、不安全整数全部拒绝。按各单位真实接纳时间保留滚动窗口，恰好60秒时过期。
- `assertGenerationRateLimit(userId, count): void` 从 `@/lib/server/generation-rate-limit` 导入，使用 `Symbol.for("narra.generation-rate-limit")` 与 globalThis 共享一个5单位/60000ms限流器。每次调用动态读取/惰性创建，Next模块重新加载不会重置额度。超额抛现有 `ApiRateLimitError(status=429)`，文案为“请求太频繁：每个用户每分钟最多生成 5 张图片，请稍后再试”。
- 两位调用方代理已收到完整API与测试隔离说明；测试可在before/afterEach删除这个Symbol属性，单独resetModules应保留额度。

## 验证

先添加回归运行旧实现，`credits.test.ts` + `rate-limit.test.ts`：**20 failed / 5 passed**，退出1，见 `core-red.log`。保留了旧计费行为和缺少新原子操作的真实失败。初次尝试保存回执时research目录不存在，命令未启动；创建任务目录后才运行此红回归，未把目录错误当作产品失败。

实现后：

```text
node node_modules/vitest/vitest.mjs run src/tests/unit/credits.test.ts src/tests/unit/rate-limit.test.ts src/tests/unit/generation-rate-limit.test.ts --maxWorkers=2
3 files / 35 passed，退出0，见core-green.log。

node node_modules/eslint/bin/eslint.js src/lib/credits.ts src/lib/server/rate-limit.ts src/lib/server/generation-rate-limit.ts src/tests/unit/credits.test.ts src/tests/unit/rate-limit.test.ts src/tests/unit/generation-rate-limit.test.ts
退出0，无诊断。

node node_modules/typescript/bin/tsc --noEmit -p .trellis/tasks/11-21-image-quota/research/tsconfig.core.json
退出0，无诊断。
```

类型检查配置继承项目严格配置，仅包含本次六个文件，关闭incremental，不修改全局构建缓存。全项目类型检查由主代理在调用方接入完成后执行，不能把本次局部通过当作全仓通过。

最终全项目类型检查通过后，已清理这份临时局部配置，避免归档路径变化留下不可用的检查入口；以上命令保留为当时执行记录。

测试覆盖4+2拒绝+1允许、独立用户、分批滚动60秒边界、8个并发调用仅接受5个、模块重载共享全局状态、非法单位不消耗/减少额度、旧record与新tryRecord共享窗口，以及4张计费、19/20余额、1～4批次、图生图/视频固定1和自填渠道0。

已检查已跟踪文件diff与两个新增源码文件的no-index whitespace检查：没有空白错误；新增文件有仓库已有LF→CRLF提示。没有新增冗余抽象或计费/配额重试逻辑。

## 边界

这是当前单应用进程的提交张数限额，重启清零；不提供跨多个Node进程/副本的分布式保证。额度接纳后审核/生成失败仍占该窗口，退款是独立既有积分补偿流程；核心不尝试按异步完成时间回退配额。调用方需统一使用实际count并在副作用前调用门禁，Canvas重放需先返回；这些路径由另外两位代理接入与验证。
