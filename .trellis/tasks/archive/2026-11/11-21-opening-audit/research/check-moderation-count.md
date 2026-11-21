# 合并违规计次独立复核

2026-11-21：只读审阅 `src/lib/moderation/check.ts` 的本轮 diff、相应单元测试，以及网页/API/头像/署名调用顺序；未发现阻断项。未改产品代码或访问生产服务。

- `check.ts:155–179` 对同一用户、相同 `now - 24h` 创建时间下界，合计 ContentReview 的 sensitive_word/ai_moderation 与 BUILT_IN + FAILED + 现有上游拒绝标记任务。单个任务即使匹配多个 OR 条件也只 count 一行，不按匹配词数累加。
- `:75–85,114–127` 两个明确拒绝写入分支都立刻返回。敏感词命中不会再做本地/远端审核，本地模型拒绝不再远端审核，多个远端拒绝结果仍只写一次。网页在审核后才创建预备 job；external-api.ts:197 与 gateway-client.ts:247 同样先审核再入队/转交。因此一次预审拒绝不会又出现在上游失败任务计次中。
- `:55–65` 任一计数查询失败，均返回固定审核不可用提示，日志不带原异常，不新增违规，也不继续调用模型。配置、本地模型、远端超时/服务错误沿原不可用路径结束，不写违规记录；没有把所有失败任务或通用错误码都当违规。
- 头像 route:65 与署名 showcase route:46 都使用 builtIn:true，复用同一暂停检查；不修改公开署名友好错误文案。匿名投稿仍无署名审核。ContentReview 无渠道字段，既有可选自填审核的明确违规会影响后续站内提交；自填生成本身的可选审核/暂停查询语义保持。
- 保留原任务创建时间窗口和已进入审核请求的行为；没有额外锁住用户全部审核，不能宣称它会撤销并发已开始审核或已经提交给上游的任务。本次为已确认的合计规则，不是新增账号永久封禁。

实际独立验证：使用 disposableTestEnvironment 合成环境、deny-env preload，执行 moderation-check.test.ts、external-generation-service.test.ts、avatar-route.test.ts、work-showcase-route.test.ts，`--maxWorkers=2`，4 套 125/125 通过，5.32 秒。包含实际共享审核函数及模拟历史查询条件；不是实际 PostgreSQL/上游验收。其余全量检查由主代理统一执行。
