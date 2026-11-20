# API / 网关按张计费与额度接入

2026-11-21，trellis-implement。读取任务 PRD/design/implement、implement.jsonl 及质量/输入/网关/Canvas 规范；仅修改两条服务入口和对应测试，未提交或部署。

## 修改

- `src/lib/generation/external-api.ts` 与 `gateway-client.ts` 各调用一次共享 `resolveGenerationCount`，在原 API Key 请求限流后、审核前消费用户图片额度。沿用同一 count 计算费用、预留输出、写任务或签名 envelope；文生图请求 1～4 张按实际张数，图生图始终 1 张。
- 每个入口只增加一个共享额度调用与费用参数，删除原局部张数判断；退款、Worker handoff 和网关不确定状态分支均未改动。legacy 在原事务中按完整费用条件扣减，余额不足抛错回滚；网关继续在上传/转发前原子预扣。
- 直接使用真实共享 limiter 与真实计费函数测试，不 mock 这两层。测试前后删除专用 global Symbol 隔离额度；外部服务旧测试改为 stubEnv/unstubAllEnvs，合成 DB 地址指向不可用本地端口，测试不读写数据库。

## 回归

- 文生图 4 × 5 = 20，任务、输出预留、HMAC 签名 envelope 和预扣金额一致；余额 19 拒绝，legacy 模拟事务未提交任何 job，双方均不 handoff/转发或误退款。
- 两张参考图 + 请求 count 4，实际输出仍为 1、费用 5；网关随后同用户仍可提交 4 张，证明参考图数量与请求 count 不多占额度。
- 同一用户 legacy 4 张 → 不同 Key 网关 2 张 429 → 另一 Key 网关 1 张成功 → legacy 再 1 张 429；拒绝没有审核、预留、扣费或上游调用，另一用户仍能提交。原 API Key 请求限流先拒绝时不消耗图片额度。
- legacy 四张任务交接前失败保存 creditsSpent 20 并只触发一次现有退款入口；Worker 已接管后的失败不重复退款。网关参考图上传失败退还实际预扣 20 一次（该用例设置单图渠道价格 20），4 × 5 的网关明确未建任务失败退 20 一次；已建任务 504、或连接和状态查询同时失败均不误退 20。另连跑主代理更新的真实退款函数/CAS 单测。

## 验证

入口修改前 red：2 suites，12 failed / 13 passed。此时核心必填 count 接口已由另一分工更新，而入口尚未传入，故计费失败表现为 NaN；跨入口额度用例明确复现未阻止 4 + 2。

最终：

```text
node node_modules/vitest/vitest.mjs run src/tests/unit/external-generation-service.test.ts src/tests/unit/gateway-client.test.ts src/tests/unit/external-v1-routes.test.ts src/tests/contracts/gateway-contract.test.ts src/tests/unit/job-refund.test.ts --maxWorkers=2
```

5 suites / 70 tests 通过。两服务与两测试文件定向 ESLint、git diff --check 均通过。没有连接 PostgreSQL 的集成测试；事务回滚验证是明确建模的单测，不能冒充实际 DB 验证。网页/Canvas 入口由另一分工负责，全量类型/构建和最终发布由主代理完成。

## 后续独立审阅发现的流式状态码修正

generation 分工发现 legacy Kelivo 的 images generations/edits 保活、Responses stream 会先发 HTTP 200，再执行服务限额，因此额度正确拒绝仍无法返回所需 429。

- 在 `external-api.ts` 抽出 `startExternalGeneration(args)`，先完成原 API Key 防刷、统一 count 和用户图片额度，再返回 `{ result: runAcceptedExternalGeneration(args, count) }`。后者私有，沿用全部审核/入队/退款代码。原 `runExternalGeneration` 复用 start 并等待 result，没有跳过额度的公开参数，也没有重复记账。
- 三个受影响 `/v1` 路由在构造保活 / SSE 响应前 await start；只在流内部等待生成结果。普通 JSON、根路径别名、正常保活和 Responses 后续事件继续复用现有格式逻辑。网关入口本已在返回 Response 前检查额度，不重复拆分。
- `external-generation-service.test.ts` 使用真实路由、真实 start/run/计费/共享 limiter：先由两个 API Key 提交 4+1 用满额度，再调用三个真实 HTTP 入口，要求 429 JSON `rate_limit_exceeded`、无审核/预留/事务/扣费/上游。图生图使用实际 PNG 的 multipart；另有真实 Kelivo n=4 成功后另 Key 剩余 1 张成功，防重复消费。
- 旧 `external-v1-routes.test.ts` 只更新 mock start 的 `{ result }` 形状，保留生成未完成时可立即读保活块、正常 SSE 与别名回归；其旧直接 process.env 写入也改为 stubEnv/unstubAllEnvs，避免泄漏合成配置。

新增真实路由回归的 red 为 3 failed / 14 passed，三项均精确复现 HTTP 200 而非 429。修正后：

```text
node node_modules/vitest/vitest.mjs run src/tests/unit/external-generation-service.test.ts src/tests/unit/external-v1-routes.test.ts src/tests/unit/gateway-client.test.ts --maxWorkers=2
```

3 suites / 58 tests 通过；受影响服务、三个路由、两个测试文件定向 ESLint 与 diff --check 通过。已通知主代理源码定稿，并通知两名独立审阅者；此后全量与构建由主代理重新执行。
