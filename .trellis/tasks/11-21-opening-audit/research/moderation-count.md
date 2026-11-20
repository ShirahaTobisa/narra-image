# 站内与上游合并违规计数

2026-11-21：用户确认同一用户滚动24小时内，站内明确违规与上游内容拒绝合计达到3次后暂停后续站内提交；审核超时、服务故障不计。此追加变更尚未由本代理部署。

## 最小实现

- `src/lib/moderation/check.ts` 在原共享入口并行查询两个现有表，使用同一个 `createdAt >= now - 24h`，相加后检查3次上限。
- 站内仅统计该用户 `ContentReview.kind in [sensitive_word, ai_moderation]`。上游沿用该用户 BUILT_IN、FAILED 任务和三个不区分大小写的明确消息标记：`moderation_blocked`、`content_policy_violation`、`safety system`。单个任务命中多个标记仍只计一次；不把通用错误码或普通服务失败当违规。
- 查询置于原配置读取 try/catch；任一查询失败返回 `MODERATION_UNAVAILABLE_MESSAGE`，固定日志不带数据库异常内容，不新增违规。审核阈值、严格图片门禁、计费及限流均未改动，无新表/字段/缓存状态。
- 保留导出名 `PROVIDER_COOLDOWN_MESSAGE`，只改提示文字为站内内容审核和模型方安全审核累计拒绝，避免影响调用接口。

## 不重复计次的证据与范围

- 该文件只有两处 `contentReview.create`：敏感词命中或 AI 判定拒绝，创建后均立即返回。图片本地拒绝直接结束，不再远端送审；远端返回多个拒绝结果也只写一条。
- 普通网页 `src/app/api/generate/route.ts:142` 先审核，`:290` 才创建任务；外部 `src/lib/generation/external-api.ts:197` 先审核、`:217` 才创建任务；`gateway-client.ts:247` 先审核再转交网关。因此同一次预审拒绝不产生可被上游拒绝计数的任务。不引入假请求标识或额外去重表。
- ContentReview 没有 providerMode，所有上述明确 kind 都计入，不能声称只来自内置生图。现有头像 `src/app/api/me/avatar/route.ts:65` 与公开署名 `src/app/api/me/works/[id]/showcase/route.ts:46` 都传 `builtIn:true`，自然共用暂停入口；署名路由保留自己的公开文案。匿名投稿不经过署名审核，行为未改。
- 可选自填渠道审核产生的明确拒绝也影响该用户后续站内提交；自填生成本身仍保留原开关/不查询站内暂停的语义。按照现有记录的创建时间统计，并非从第三次开始额外固定封锁24小时。
- 新规则作用于现有窗口内记录；没有回填或清理历史违规，也没有改变已提交任务的生命周期。并发中已进入审核的请求仍按各自结果处理，此变更不是锁住整个用户审核过程。

## 验证

先补测试、保持原实现：`moderation-check.test.ts` 共78项，6失败/72通过。失败包括漏算两次站内加一次上游、第三次后仍送审、未执行站内查询，以及两种计数查询错误未正确收口。最小修复后78/78通过；随后补纯图片/署名文字共享入口断言。

最终使用 `disposableTestEnvironment` 合成环境和 deny-env preload，无真实数据库、网络或生产访问，执行：

```text
node node_modules/vitest/vitest.mjs run src/tests/unit/moderation-check.test.ts src/tests/unit/external-generation-service.test.ts src/tests/unit/avatar-route.test.ts src/tests/unit/work-showcase-route.test.ts --maxWorkers=2
```

结果：4文件、125/125通过（80+17+9+19），4.54秒。真实共享审核逻辑以数据库 fixture 执行实际查询条件，覆盖不同用户、过期记录、未知kind、非内置/非失败任务、多个消息标记、第三次拒绝后第四次提前停止，以及模型/超时/服务/配置/计数故障不增加违规。外部服务真实导入审核入口的原 fixture 仅补 `contentReview.count=0`，保留无上传/扣费/任务断言；头像/署名路由测试保留入口参数与拒绝不写入断言。未把模拟数据库测试声称为真实数据库验收。

ESLint：`check.ts`、`moderation-check.test.ts`、`external-generation-service.test.ts` 通过。全量类型/应用/构建及发布由主代理统一执行。
