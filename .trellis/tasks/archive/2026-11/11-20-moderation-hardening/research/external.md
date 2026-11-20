# 非创作台入口与 Worker 审核复查

2026-11-20，本地代码审阅；未调用线上生成或审核服务，未证明这些缺陷曾被利用。阅读了本任务 PRD/design/implement 与 generation-inputs、gateway、quality-guidelines 规范。

## 已确认问题

1. **共享审核可关闭，且 AI 漏审反向提示词。** `src/lib/generation/external-api.ts:184` 与 `gateway-client.ts:244` 都经过共享审核，但审阅时 `src/lib/moderation/check.ts:57` 直接允许 `isEnabled=false`，`aiEnabled=false` 也可仅经过关键词后放行。`:89` 只把 prompt 传给 AI；外部 images generations 的 negativePrompt 会保存（`external-api.ts:217` / `gateway-client.ts:291`），Go `generation.go:147` 会将其发给上游。最小修复在共享入口强制本站渠道具备有效 AI 审核，并审核实际提交的两段文字；两条外部路径补阻断时无扣费、无上传、无入队的断言。此项由审核核心负责。

2. **上游拒绝信息丢失，用户冷却和渠道健康漏判。** `worker/internal/worker/generation.go:365,372` 只从 Responses JSON/SSE 收集图片。HTTP 200 中 `response.failed`/明确 refusal 没有保留，最终在 `:248` 被转成“单次图片工具调用必须返回一张图片”。HTTP 400 的 `content_policy_violation` 被 `lifecycle.go:184` 当普通参数错误。`src/lib/moderation/check.ts:145` 与 `src/lib/providers/built-in-provider.ts:253` 只识别 `moderation_blocked` / `safety system`，因此这些明确拒绝不累计冷却，还可能被算作渠道故障。最小修复复用 `PROVIDER_POLICY_REJECTED`，结构化识别明确拒绝并使用含 `moderation_blocked` 的固定消息，不记录原始正文；不自动重试，保留已知失败退款语义。回归覆盖 HTTP 400、HTTP 200 JSON/SSE/refusal、正常图片与一般服务错误。

3. **外部参考图下载未固定已验证 IP，且正文限额/超时不完整。** `src/lib/external-api/source-images.ts:156,169,175` 先 DNS 校验再普通 fetch，第二次解析可以变化；`:181` 在响应头到达即清掉超时，`:233` 先完整 arrayBuffer 再检查 10 MiB，分块正文能越界或长时间占用。API 关闭会先拒绝，因此此项可达条件是 API 已启用且持有有效 API key。最小修复复用现有 `fetchPublicHttpUrl` 的固定地址、防重定向能力并流式限额，超时覆盖读完正文。补 mock DNS 地址变化、无 Content-Length 超限、慢正文、managed 图片保持可读的测试。`image-edits.ts:154,165` 还没有参考图数量上限，可加统一上限避免无界并发下载；Responses/chat 已有 4 张上限。

## 核验通过的边界

- `/v1/images/generations`、`images/edits`、`responses`、`chat/completions` 均先 `requireApiUser`；无 `/v1` 别名及单数 `chat/completion` 直接 re-export 相同 handler，未找到别名跳过认证/审核的路径。`api-auth.ts:31` 在解析/下载媒体前检查 API 开关。
- Legacy 与 gateway 都在审核之后才扣费/持久化/入队。参考图下载一次成为 Buffer，送审后以同一 Buffer 上传（`external-api.ts:263`、`gateway-client.ts:153`），worker 读取本站副本，不重新读取客户端原始 URL。未发现这两条链的直接可变远程 URL 换图绕过。
- 内部 Go gateway 先 HMAC 校验再创建任务（`gateway.go:180,202`），校验时间窗口；本仓库 compose 仅 expose worker 8081，无公网 ports 映射。Go 不重复审核，信任已签名的 Next 入队边界；不可将内部入口改成公开无签名入口。
- Go 图片 generation/edit/Responses 都给本站渠道添加用户散列 safety_identifier；本站渠道不转发客户端 moderation=low（`generation.go:116-147,184,264-280`）。客户端 tools 仅用于网关响应格式，不作为原始生成工具配置透传。
- Worker 自身远程图片读取使用连接时校验并固定公网 IP、正文上限和超时（`storage.go:295,425`）。本站 S3 副本依赖唯一且不覆盖的对象 key；managed 图片另有可用性/完整性核验。

## 限制与次要项

- 未验证当前生产 API/视频开关；由主代理做脱敏状态检查。不能仅凭 README 推定入口永远关闭。
- 视频 `video.go:93,146` 未添加 safety_identifier，但当前外部 `/v1` 生成解析只产生图片任务，视频只从共享网页生成入口入队。若以后公开视频，应同步补标识；不能把标识视为站长账号免罚保证。
- 外部 API 限流统计已创建任务，下载和审核前置失败不会记入统计；会放大上面的下载资源消耗，应在启用外部 API 时评估请求计数边界。它不等于已经证实 NSFW 通过审核。

## Worker 实施与复查结果

- 复用现有 `PROVIDER_POLICY_REJECTED`，明确 HTTP 拒绝与 Responses JSON/SSE/refusal 使用固定 `渠道内容审核拒绝（moderation_blocked）` 消息；不持久化原始拒绝正文、不自动重试。部分响应或前序批次已有图片时保留 `ResolvedAfterSubmit=false`，继续使用既有 v1 `SUBMITTED → UNKNOWN` 保护，不能自动退掉已部分生成的整单。
- 独立复查发现：`response.refusal.done` 仅表示一个拒绝内容片段结束，正常 EOF 不能证明整个响应完成。最终实现另外要求 `response.completed`、`response.failed`、`response.incomplete` 或 `[DONE]` 终结标记；任一 data JSON 解析失败、扫描失败或已有图片均不得标为确定完成。仍保留安全拒绝 marker，未完成的流在既有 v1 生命周期中进入 UNKNOWN；legacy 失败补偿行为不变。
- 新增 6 个 SSE 边界场景：EOF-only、三种明确结束、结束前/后损坏 JSON。先运行回归确认三个缺陷场景失败，再最小修改收集器后通过。连同原有拒绝/允许/部分批次场景，新增测试共 23 个场景。
- 定向验证：`go test ./internal/worker -run 'TestProviderPolicy|TestResponsesPolicy|TestImageGenerationSafety|TestImageEditSendsSafety|TestResponsesRequestSafety|TestProviderErrorBodyIsTruncated|TestGenerateWithImage' -count=1` 通过；未运行线上或数据库测试。主代理负责全量验证和部署。

## 最后修复的独立复核

- `assertModerationImages` 已显式向容器校验传入 20 MiB；`verifyCanvasImage` 默认仍为 Canvas 的 8 MiB，`canvas/assets.ts` 两处调用仍使用默认值。真实大于 8 MiB 的静态 PNG 在审核路径通过、Canvas 默认路径拒绝；容器 CRC、MIME、完整性与动画检查未因限额参数而绕过。
- 后台页面 header 与表单均已明确审核关闭/超时/异常会拒绝站内生成；已搜索后台页面与组件，没有残留“降级放行”说明。
- 审核响应有覆盖字段且提交包含文字时，同时要求 `sexual` 和 `sexual/minors` 包含 text；负向文字与图文请求也走该判断。纯图片要求 `sexual` 的 image 覆盖，不要求官方不支持的 minors image 覆盖；旧版纯文本响应缺覆盖字段的兼容范围保持不变。
- 未发现这些已指定边界的新遗漏。独立执行 `moderation-images.test.ts`、`moderation-check.test.ts`、`canvas-storage.test.ts`，3 个文件、104 个测试全部通过。仅追加本文档，没有修改产品代码；没有线上或数据库调用，全量检查与发布由主代理完成。
