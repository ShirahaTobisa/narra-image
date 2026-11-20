# 审核配置、输入与响应复查

- 日期：2026-11-20
- 研究范围：只读源码、既有测试与官方接口文档；研究阶段没有访问生产或修改产品代码。以下缺陷行号取自修复前源码；随后授权实施的范围与验证见文末。
- 依据：本任务 PRD/design/implement、`operations/generation-inputs.md`、`operations/gateway.md`。

## 优先修复

### P0：站内渠道可以在没有有效 AI 审核时放行

- `src/lib/moderation/check.ts:57`：`isEnabled=false` 直接通过，未区分 `builtIn`。
- `check.ts:81`：`aiEnabled=false` 跳过 AI，最终通过。关键词可关闭，且即使打开也不能等同于语义/图片审核。
- `src/tests/unit/moderation-check.test.ts` 的“站内渠道拦截次数未到上限时照常审核”实际上将审核总开关设为关闭并断言站内放行，覆盖并固定了这个漏洞。
- 最小修复：仅对 `input.builtIn===true` 强制 `isEnabled && aiEnabled`、非空可信配置、适用的审核能力与有效响应；任一不满足返回 `MODERATION_UNAVAILABLE_MESSAGE`，不建任务、不记用户违规。对于 custom，保留既有开关语义。不要把站内回退到关键词审核当作降级成功。
- 测试：站内总开关关闭、AI 关闭、只有关键词、地址/密钥缺失、解密失败均拒绝；custom 在总开关关闭时仍按原策略放行；站内有效 AI 及合法结果才允许。

### P1：实际提交的负向提示词未经过 AI 审核

- `check.ts:89` 只把 `input.prompt` 送给 `callModerationAi`；`negativePrompt` 仅用于关键词检查和记录。
- `worker/internal/worker/generation.go:147` 确实会向生图提供方发送 `negative_prompt`。因此语义审核与上游实际文字输入不一致。
- `check.ts:81` 的触发条件也忽略只有负向文字的情况。
- 最小修复：明确标注正向/负向后合并两者，或按接口支持的文本输入结构送审；检查是否有待审文本时也包含负向。不得修改最终生成的原始语义来伪装成已审核。
- 测试：只在 negativePrompt 中出现的受限语义能被模拟审核判定拒绝，断言请求 body 确实包含它；空正向+非空负向也送审。

### P1：任意非空分类字典仍被当成完整审核，未确认图片真正被审核

- `src/lib/validators.ts:45-51` 只要求 `flagged:boolean` 和非空任意 `category_scores`。`{flagged:false,category_scores:{hate:0}}` 合法，缺失性内容分类也能通过。
- `check.ts:204` 将缺失 `sexual/minors` 当成 0。`categories` 的分类布尔值和 `category_applied_input_types` 都被丢弃。
- 最小修复：针对站内要求所需性内容分类分数，拒绝缺项；采用分类布尔值为真即拒绝，不能让不一致的 `flagged:false` 覆盖它；参考图输入须有明确适用图片的性内容审核结果。只检查模型名称不足以证明服务实际处理了图片。
- 官方接口说明确认：`sexual` 支持文字和图片；`sexual/minors` 只支持文字。图片请求应核验 `category_applied_input_types.sexual` 包含 `image`，不能要求 `sexual/minors` 包含 `image`。后者官方正常响应就没有该能力；不支持图片的分类可能给出 0，0 不代表已审图。
- 测试：只有无关分类、缺 sexual、文字输入缺 sexual/minors、图片响应缺 `image` 适用范围、分类 flag=true 但 aggregate flag=false 均拒绝；完整的官方格式正例通过。

## 配置与次要问题

### P2：默认值和后台说明与现有安全行为不一致

- `src/lib/env.ts:211`、`prisma/schema.prisma:172`、`.env.example`、后台 placeholder 仍默认 `text-moderation-latest`；当前文档的多模态默认模型是 `omni-moderation-latest`。新默认应同步运行时事实表、env、文档和 UI；既有行继续按实际能力判定，不静默认为旧值具备审图能力。
- `src/components/admin/moderation-config-form.tsx:145` 和 `src/app/admin/settings/moderation/page.tsx:35` 仍声称超时自动放行；实际代码已拒绝。应准确说明站内要求 AI 审核且故障会停止生成。
- 不修改已发布数据库 migration；若无需改变 schema，可由配置创建显式填写新的默认模型。

### P2：首次局部保存配置可能关闭原本已启用的审核

- `src/lib/moderation/config.ts:119` 首次 upsert 的 create 仅包含 PATCH 字段；其余落到 Prisma 默认 `isEnabled=false/aiEnabled=false`。
- 当 env 开启审核而 DB 尚无行时，仅 PATCH 阈值会创建默认关闭的行，随后 DB 优先规则关闭审核。常规 UI 当前一次发送全部字段降低了触发概率，但 PATCH API 明确允许局部更新。
- 最小修复：首次创建以当前有效的非敏感配置为基底，再覆盖 patch；保留 env 密钥回退或显式按现有加密流程保存，不能把明文 key 写到其他字段。
- 测试：env 已开启、无行、仅改阈值，返回配置应仍开启且其他值保持。

### P2：关键词缺少基本 Unicode 规范化

- `src/lib/moderation/sensitive-words.ts:93` 只做小写化。全角字母、零宽字符可让原本在词库中的内容无法匹配。
- 最小修复：只在关键词扫描副本上做 NFKC 与明确的零宽格式字符清理，保留原始提示词送语义审核和生成；不要靠扩张词库替代 AI 门禁。
- 测试：词库内标记的全角形式、词中零宽字符均能匹配；已有 analysis 等非命中正例继续通过。

### P2：上游违规冷却只识别两个原始错误片段

- `check.ts:143-146` 按任务创建时间及大小写敏感的 `moderation_blocked` / `safety system` 计数。
- `content_policy_violation` 等明确拒绝码不计入；排队较久的任务也可能在最近拒绝但因创建时间过早漏计。
- 最小修复：复用 Worker 的真实错误归类（若可用）；或至少补明确内容拒绝码、大小写不敏感并按失败时间统计。不要把所有 400/`PROVIDER_REQUEST_INVALID` 都当内容违规。
- 测试：各种明确内容拒绝码计入，取消/配额/参数错误不计，较早创建但刚失败的记录计入。
- 后续核实：`PROVIDER_POLICY_REJECTED` 还用于普通视频轮询/HTTP 失败，不能单凭这个结构化代码计入内容违规。本轮仅识别明确的 `moderation_blocked`、`content_policy_violation`、`safety system` 标记，并兼容大小写；仍保留原有创建时间窗口。

## 凭据与错误边界

- 正常管理配置响应仅返回 `aiConfigured` 等元数据，没发现 API Key 明文回传；PATCH/GET 都经过管理员检查。
- 原来的非 2xx 原始响应正文已经不进入错误消息，这是保留项。
- `check.ts:91` 仍直接记录完整 Error 对象，且配置解密在外围 try 之外。配置失败应统一返回审核不可用；日志仅保留稳定原因或现有脱敏投影，不直接记录任意上游错误/URL/头值。未观察到真实泄漏，不应把它描述成已发生事故。
- `config.ts:102-105` 检查 API Key 的 trim 结果但加密原文，可顺便在保存时 trim；否则复制空白可能导致配置不可用。

## 官方资料与结论边界

- [OpenAI Moderation guide](https://developers.openai.com/api/docs/guides/moderation)：多模态输入、分类适用类型、性内容与未成年人分类的能力差异，分数随模型升级需要校准。
- [Create moderation API](https://developers.openai.com/api/reference/resources/moderations/methods/create)：当前默认模型、分类/分数/适用输入类型字段。
- AI 分类只能减少风险，不能证明所有未来输入都无 NSFW，也不能承诺账号不会被服务方处理；有效审核、覆盖实际输入、故障拒绝是本轮可以验证的边界。不能通过非 NSFW 探测证明分类准确率。

## 共享审核入口实施与验证

- 根据父任务后续授权，仅修改 `src/lib/moderation/check.ts`、`src/lib/validators.ts` 的审核响应 schema 和 `src/tests/unit/moderation-check.test.ts`。图片验证由另一实施者的 `assertModerationImages` 提供，在审核请求前调用；没有重复图片解析逻辑。
- 站内必须开启审核及 AI，并有合法地址、密钥、模型和阈值；空输入、缺配置、配置读取/解密失败、上游失败或不完整响应统一拒绝，不记为用户内容违规。异常日志仅含固定原因，没有任意错误对象、URL、凭据或上游正文。
- 正面与负面文字全部送审；出现负面文字时用 `Negative prompt (content to avoid)` 保留排除含义，不截断。正常仅正面输入维持原有正文。
- 必须包含 `sexual`、`sexual/minors` 的分数与分类布尔值；任何分类布尔值为真均拒绝。图片响应必须覆盖 sexual 的 image，有伴随文字还必须覆盖 text；合法的 minors 仅 text 或纯图片时空适用类型不被错误拒绝。
- 站内 sexual 阈值采用 `min(配置阈值, 0.2)`，未成年人仍为 0.02；0.2 是保守站点策略，不是校准的风险概率。其他类别及自填渠道继续原有阈值；自填渠道关闭审核的语义保留。
- 冷却识别明确上游内容拒绝及其历史写法，不把通用 `PROVIDER_POLICY_REJECTED` 当违规。创建时间窗口未扩大修改。
- 先运行新增回归：59 项中 31 失败、28 通过，见 `moderation-check-red.log`。初次与真实图片 helper 集成有 3 项失败，源于手写 PNG 夹具 CRC 无效，保留 `moderation-check-initial-integration.log`；改用仓库既有 `canvasPng` 后 59/59 通过，见 `moderation-check-green.log`。
- 验证命令：`node node_modules/vitest/vitest.mjs run src/tests/unit/moderation-check.test.ts --maxWorkers=2`；三个修改文件的定向 ESLint 与 `git diff --check` 通过。完整类型/构建/全量测试由父任务统一运行，本次没有重复跑。
- 本实施者没有访问生产、提交或部署。父任务另行完成的无害 text、text+PNG 官方审核探测，已确认当前官方响应具备本 schema 所需字段；该探测不证明模型准确率。

### 独立审阅后的文本覆盖补漏

- studio 审阅发现：首次修复只检查带图请求的 sexual 覆盖，仍会把“明确返回 coverage 但缺文本能力”的纯文本响应当成通过，也未核对图文的 minors 文本覆盖。
- 最小补丁仅修改 `check.ts`：当有待审文字且返回了 `category_applied_input_types` 时，`sexual` 与 `sexual/minors` 都必须包含 `text`。图片仍要求 sexual 包含 `image`，不要求 minors 包含 image；整个 coverage 字段缺省的旧版纯文本接口保持兼容。
- 新增空 coverage、sexual 仅 image、minors 空覆盖、纯负面文字与带图文字缺 minors text 的 5 个回归，并让纯文本正例采用官方 `sexual=[text]`、`sexual/minors=[text]`。
- `moderation-text-coverage-red.log`：修复前 5 失败、59 通过；`moderation-text-coverage-green.log`：修复后 64/64 通过。定向 ESLint、`git diff --check` 再次通过。

### 下载器与 Worker 最终补丁复核

- 仅复核此前报告的边界，没有修改产品文件或扩展重构。未发现这几处修复仍有阻断项。
- `fetchPublicHttpUrl` 已在 DNS 解析外围监听 abort，解析前后均检查取消；以当前文件内存转译、替换 DNS/HTTP 的独立验证重放原场景，结果由 `still-pending-after-abort` 变为 `rejected`，随后返回的 DNS 结果被忽略，实际网络调用数为 0。
- 204、205、304 生成空正文 Response 前均显式 `upstream.destroy()`，不会再依赖调用方取消一个不存在的 body；响应构造异常也在同一清理分支内。父任务新增并通过的四个边界回归与这两处代码行为相符。
- SSE 拒绝仅在有 `response.completed/failed/incomplete` 或 `[DONE]`、无 JSON 解析失败、无扫描失败且无已产图片时标为 `ResolvedAfterSubmit=true`。EOF-only 与结束前后坏 JSON 均保留 false，进入既有 v1 UNKNOWN 保护，不触发整单确定退款；部分图片、部分批次和不自动重试的保护仍在。
- 已阅读 Worker 新增终结/坏 JSON 正反回归与实施者通过记录；没有重复执行全套测试，也没有访问真实服务。Node 冷却仍只依据明确内容 marker，不把通用 `PROVIDER_POLICY_REJECTED` 作为违规计数条件。
