# 网页与 Canvas 按张计费/限额

2026-11-21，trellis-implement。仅修改 `src/app/api/generate/route.ts` 和三份相关单测；没有改核心计费、限流、API/网关或 Worker，没有连接生产、提交、推送或部署。

## 实现

- 解析、Canvas reserve/replay 和禁用功能检查后，用共享 `resolveGenerationCount` 计算一次有效 `count`；在验证码、读参考图、内容审核之前调用共享用户图片额度。
- 同一 count 传入真实计费/余额校验、输出预留和任务记录。文生图4张单价5为20分；图生图即便传入 count4，也保存 count1、预留1、扣5分。视频仍由共享函数归一为1，自填渠道仍由真实计费函数返回0。
- 保留现有早期5请求防刷、每人最多2个活动任务、事务内条件扣费、审核与原图来源核验。旧防刷只显示“请求太频繁”，不再把5次称作图片额度。
- `ApiRateLimitError` 在普通网页返回429；Canvas先拒绝已取得的 preparation，再返回私有不可缓存的429。若 preparation拒绝未确认，仍沿用既有只读恢复路径，不假称确定清理成功。没有建立任务或扣费。
- 后续审核/余额/渠道等失败不回补已接受的图片额度，遵循本任务设计；退款继续只针对积分，未改生产退款实现。

## 真实回归

先移除网页测试中的假计费，保留真实计费和图片 limiter；通用 limiter 仅替换旧请求防刷的 `isLimited/record`，新 `tryRecord` 保持真实。每例前后清除共享 singleton，测试互不借用额度。

首次红回归：20个网页测试有5个真实失败——余额19竟可提交4张、4张只记录5分、图生图count4原样入库、4+2都接受、并发4+4都接受。修复后覆盖：

- 文生图4张：19分返回402，无任务/扣费/输出预留；20分提交成功，job count4/creditsSpent20，条件扣费gte20/decrement20，输出预留4。
- 图生图2张参考图、恶意count4：job count1/creditsSpent5，条件扣费5、输出预留1。
- 4张后2张返回429，验证码/审核/扣费调用次数未增加；余下1张仍成功。不同用户独立，同用户并发4+4只有一个成功。
- Canvas真实parser与既有回滚型事务夹具：2张扣10；提交重放后仍可接受新3张，证明重放不重复消费图片额度；网页4张后Canvas2张返回private/no-store的429，preparation变REJECTED、无额外扣费，新1张仍可提交。
- 复用 Canvas 原有缺失ACK、未知commit、锁/租约失败、重放、引用读取及审核测试，只按实际张数更新应扣余额。图生图及旧单张余额预期保持5分。
- 真实退款函数使用真实4×5计费值，确定失败时并发/重复调用只补20分一次；已有SUBMITTED/UNKNOWN保守不退规则继续通过。

## 验证

```powershell
node node_modules/vitest/vitest.mjs run src/tests/unit/generate-route-security.test.ts src/tests/unit/canvas-generate-route.test.ts src/tests/unit/job-refund.test.ts --maxWorkers=2
node node_modules/eslint/bin/eslint.js src/app/api/generate/route.ts src/tests/unit/generate-route-security.test.ts src/tests/unit/canvas-generate-route.test.ts src/tests/unit/job-refund.test.ts
git diff --check
```

三文件90/90通过，约6秒；定向ESLint与diff检查通过。测试无外网、生产账户或真实生成；Canvas使用已有数据库事务结果模型，不能据此声称真实PostgreSQL并发锁验证。完整类型/构建/全量测试与发布由主代理完成。

产品route净增7行（14增/7删）；其余为实际行为回归和既有Canvas金额预期更新，没有新增产品抽象、状态或数据库字段。
