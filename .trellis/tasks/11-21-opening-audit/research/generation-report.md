# 开站报告复核：生成、审核计数、退款与封禁

复核日期：2026-11-21。代码基线 `da7915a`（应用上线版本 `1c50f24`）。依据用户提供的 `D:/tools/claude/reports/narra-image-开站排查-2026-11-21.md`、本任务 PRD/上下文清单及生成输入、图片存储、Worker 契约和发布规范。仅阅读代码和配置，运行纯本地解析示例；未调用上游或生产接口，未改产品代码。

主代理另行只读确认：生产 Worker v1=false、总并发 2、每用户活跃 1。下文的代码路径证明风险存在，不证明线上已遭滥用或发生损失。

| 报告项 | 当前结论 | 最小变更范围 |
| --- | --- | --- |
| #4 任意模型命中通配兜底 | 成立，隐藏前端选项不等于后端限制 | 应用：公共模型准入；保留正常模型兜底 |
| #4 JSON 图生图缺参考图污染健康状态 | 成立，提交成功后由 Worker 拒绝，计入渠道失败 | 应用：入口校验 + 健康查询排除输入错误 |
| #8 本地拒绝未计入三次暂停 | 成立，但当前规则明确只统计上游拒绝；并非审核绕过 | 运营规则确认后应用改动；可不改 schema |
| #16 不明结果仍退分 | legacy 成立；“上游已产出”和“站内成功展示后退分”须区分 | Worker/Node 退款契约与发布验证，不能仅改网页 |
| #17 封禁后排队任务仍运行 | 成立，Worker 从领取到发送均未读 bannedAt | Worker 首次发送前校验；无需新增 schema |

## #4：通配兜底与空参考图

### 已确认的行为

- `src/lib/providers/built-in-provider-core.ts:11` 在网页模型列表中排除含 `*` 的兜底渠道；存在普通渠道时，兜底自己的默认模型也不会展示。
- `src/lib/providers/built-in-provider.ts:220` 直接用 `channelSupportsModel` 筛候选；`src/lib/generation/contracts.ts:194` 对含 `*` 的渠道接受任何非空模型字符串。请求没有先通过公开模型集合校验。
- `worker/internal/worker/worker.go:965` 的 `upstreamModel` 会把不在明确列表中的请求模型改成兜底默认模型。因此这并非只产生一条无效模型错误，确实可能调用兜底。
- `src/app/v1/models/route.ts:13` 另有列表差异：直接枚举所有活跃渠道的 defaultModel/models，连 `*` 也会暴露；如果统一公共准入规则，该列表应复用同一规则。
- `src/lib/generation/parse-generate-request.ts:57` 仅 multipart 分支检查参考图。普通 JSON 分支 `:169–180` 接受 `image_to_image`，却固定返回 `images=[]`、`imageUrls=[]`；JSON 里的图片字段也不构成受支持的输入。
- `worker/internal/worker/generation.go:67` 加载空参考图后报“请先上传参考图”，发生在发送上游之前。`worker/internal/worker/lifecycle.go:204` 把它归为 `SOURCE_IMAGE_INVALID`；legacy 会退分。
- `src/lib/providers/built-in-provider.ts:240` 查询最近十分钟最后三条成功/失败任务，仅在 SQL 中排除 `GENERATION_CANCELLED`，再在内存排除审核错误消息。`SOURCE_IMAGE_INVALID` 会算渠道故障；三条这样的任务足以影响后续其他用户选路。

“切换十分钟”并非固定十分钟封锁：实际是十分钟滚动窗口内最近三条任务均失败，新的成功或旧记录移出窗口会改变结果。现有每用户每分钟五张限额、活跃任务上限限制频率，但没有堵住顺序提交三个快速失败请求的路径。

### 最小修复建议

1. 在公共内置渠道选择前，按网页当前展示规则校验明确允许的模型 ID。抽取/复用 `built-in-provider-core` 中的小型纯函数；不要删除通配渠道能力或修改已知模型的正常故障回退。兼顾“只有通配渠道”时它配置的明确默认模型仍可选；管理员指定渠道和自填渠道单独保持既有权限语义。
2. 普通 JSON 若声明需要参考图的类型，直接返回现有“请先上传参考图”类输入错误；继续支持现有 multipart 和 Canvas 引用，不扩充任意 URL/data URL 通道。
3. 健康查询在 `take: 3` **之前** 排除 `SOURCE_IMAGE_INVALID`，保留 `errorCode IS NULL` 兼容旧记录和原取消排除。不要笼统排除所有 `PROVIDER_REQUEST_INVALID`，其中可能含真实上游配置故障。

回归：未知模型无渠道调用；已知模型健康时走主渠道、真实连续故障仍走兜底；只有通配渠道时明确默认模型有效。JSON 空参考图无 job/扣分；multipart 与 Canvas 正常。三条参考图输入错误不使渠道失效，夹杂输入错误时仍能找到真正的最近三条健康记录。

### 已运行的隔离复现

用本机 Node 24.21.0、`node --import tsx --input-type=module -e ...` 直接调用当前 `parseGenerateRequest`、`mergeChannelsForUsers`、`channelSupportsModel`。只把 Next 的 `server-only` 导入替换成空模块（与现有 Vitest 配置的测试替身用途相同），无网络/数据库调用。输入是无害提示词 `a blue landscape` 和虚构渠道对象。

输出：

```json
{"jsonEdit":{"type":"image_to_image","images":0,"urls":0},"visible":["known-model"],"acceptsUnknown":["fallback"]}
```

这是解析/模型筛选函数复现，不是生产请求或整条数据库任务复现。首次直接执行因普通 Node 缺 `server-only` 模块退出；补测试导入替身后以上输出成功。

## #8：本地拒绝不参与暂停计数

`src/lib/moderation/check.ts:15` 的注释、`:21` 的提示语以及 `:159` 的查询均明确表示“24 小时内上游拒绝三次”。查询仅计内置渠道的 FAILED GenerationJob，错误消息含 `moderation_blocked`、`content_policy_violation` 或 `safety system`。

敏感词拒绝在 `:76` 写 `ContentReview(kind=sensitive_word)`；本地图片/远端审核模型拒绝在 `:115` 写 `ContentReview(kind=ai_moderation)`。这些请求不创建 GenerationJob，故永远不增加上述计数。它们仍被阻止发送生图上游，不能描述成绕过审核；当前图片限额也先于审核执行，因此不再是无限速探测。

若本轮希望三次规则涵盖所有明确内容拒绝，可加现有 `ContentReview` 的 24 小时计数，与上游拒绝任务数相加；两者通常互斥（预审拒绝无生图任务），无需新表。审核配置失败、服务超时、格式解析失败不能记违规。提示语需从“模型方拒绝”改为覆盖内容审核的准确说法。

边界：`prisma/schema.prisma:141` 的 ContentReview 只有用户、kind、审核结果等信息，没有 providerMode；现有数据无法可靠区分内置/自填渠道来源。无 schema 方案必须明确为“该用户所有明确内容拒绝影响站内渠道”。如果要求只计内置渠道的本地拒绝，则应新增可核验来源，而非猜 aiModel/prompt。

回归：两次本地拒绝 + 一次上游拒绝后，下一次请求在模型调用前停止；超过 24 小时不计；审核故障不计；明确测试自填渠道拒绝是否纳入选定规则。现有本地/远端严格拒绝行为和五张限额不变。

## #16：legacy 退款风险与报告中过强的结论

### 不明结果仍退分：成立

- `docker-compose.yml:29` 固定 v1=false，`:96` 默认任务超时 900 秒；主代理已单独核实生产值。
- `worker/internal/worker/job_lifecycle.go:24` 的 legacy 任务无发送状态记录；`:254` 无条件把 legacy 失败交给 `finalizeKnownFailure`。
- `worker/internal/worker/lifecycle.go:167` 将结果持久化错误标为 `HandoffUnknown`；`:180` 的部分 HTTP 5xx、`:198` 的读连接错误、`:200` 的任务取消/超时同样可能不明。但 `job_lifecycle.go:430` 仅对 v1 阻止这类自动退款，legacy 在 `:444` 仍计算退款。
- `worker/internal/worker/generation.go:237` 分次请求多张 Responses 图片。已有结果后下一次失败时虽然清除了 `ResolvedAfterSubmit`，该保护仍只由 v1 生命周期执行，legacy 会退整个任务。
- `worker/internal/worker/worker.go:1406` 的 legacy 过期 PROCESSING 清理也退分。

因此上游已收到/收费/产出、站内尚未取得或保存结果时，legacy 可能退款；不能承诺“上游出图就绝不会退款”。但接口等待超时不等于任务超时，不能把所有客户端断线都描述为立即退款。

### “站内成功图又自动退分”：本次未证实

`worker/internal/worker/worker.go:1089` 在同一事务中锁 PROCESSING 任务、插 GenerationImage、写 SUCCEEDED；`:1231` 的完成锁和失败收尾均只接受仍处于 PROCESSING 的租约。Node `src/lib/generation/job-refund.ts:70` 默认允许退款的状态也不含 SUCCEEDED，并有条件更新/已退标记保护。事务提交成功但客户端未收到确认，也不能再把该 SUCCEEDED 任务正常收尾成退款。

所以应把报告“没有图出来了又退分”改成：**未发现已成功落库展示的任务被常规失败流程重复退款；上游已产出但结果未可靠落库的 legacy 任务仍可能退款。** 无生产事故证据，不推断实际损失。

### 建议边界

本批先记录该已知 legacy 风险，不能只为止损就打开 v1 开关，也不应简单取消所有失败退款。已有 v1 的 UNKNOWN 状态是对应方向，但正式启用需单独验证 Node/Go 一致配置、数据库字段与旧任务兼容、未知任务展示/处理、重启和超时补偿。

若修改 legacy 语义，必须同时检查 Worker 常规失败/过期收尾和 Node 的退款许可；只改一条 Worker 分支可能被其他清理路径再次退款。现有 v1 schema 已存在，本风险不等于必然需要新增字段。

回归：上游返回图片后落盘失败、响应读取中断、批次前张成功后后张失败；v1 均不自动重试/退款，明确未发送的失败仍退一次。完成事务成功后模拟确认丢失，不能重复插图或退分。API 等待超时但后台继续完成不误退。

## #17：封禁不阻止已排队任务

`src/app/api/admin/users/[id]/ban/route.ts:32` 只更新 User.bannedAt。会话层拒绝封禁账号的新请求，但 `worker/internal/worker/worker.go:434` 的领取、`:634` 的处理和发送路径均不读取 bannedAt；搜索整个 `worker/internal/worker` 无 bannedAt 命中。封禁后，已有 PENDING 会被领取并发送。

只在封禁接口清理当时的 PENDING 不能完整解决：先前已通过身份检查的请求可能仍在审核，稍后才入队。`src/app/api/generate/route.ts:283` 虽锁 User 行，但没有在锁内重读 bannedAt；刚领取的 PROCESSING 也会漏掉。

最小可靠修复位置是 **Worker 首次发送上游之前**：读用户 bannedAt；已封禁则使用已有 `GENERATION_CANCELLED`，作为明确未提交失败退一次并释放预留。legacy 与 v1 都应检查，可利用 `withJobProviderLifecycle`/`markProviderSubmitting` 的一次性发送前回调；legacy 当前直接返回原 ctx，需要覆盖。若使用该回调，不应先标记 SUBMITTING 再检查封禁。

不要仅在 claim SQL 跳过封禁用户，那会留下永不终结的 PENDING 和占用的积分。不要因封禁就直接退款已发送或已产出部分图片的任务；首次发送前确认仍允许的任务继续原生命周期。无需把数据库锁持有到外部 HTTP 完成，也不承诺能撤回已被上游接受的请求。

这是 Worker 代码/契约测试与发布工作；现有 bannedAt、取消错误码、退款条件可以复用，无新增 schema 的必要。若附加应用的封禁时清理，只做明确未领取的条件更新，不能替代 Worker 检查。

回归：先入队后封禁，legacy/v1 都向测试上游发送零次、以取消结束、积分只退一次、预留释放；未封禁正常完成；封禁前已提交/部分产出的任务不自动整单退款；通过身份检查后延迟入队仍由 Worker 阻止；解封后新任务正常。

## 建议批次

1. 应用即可完成：#4 模型准入、JSON 参考图校验、健康统计排除输入错误；#8 在明确计数范围后加入本地拒绝。
2. 小型 Worker 发布：#17 首次发送前封禁校验，保留现有 v1 开关状态。
3. 单独退款契约/运维验收：#16 的 UNKNOWN 处理与 v1 启用，不混入普通输入校验补丁。
