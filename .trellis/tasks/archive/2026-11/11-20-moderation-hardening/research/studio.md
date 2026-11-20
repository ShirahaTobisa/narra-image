# Studio / Canvas 内容审核复查

日期：2026-11-20。仅静态代码与官方能力文档检查；未请求生产生图、未读取用户提示词或密钥、未运行线上违规测试。行号对应审查时版本，并行修复可能移动行号。

## 已确认

### P1：负向提示词被发送给生成服务，但未发送给 AI 审核

- `src/lib/moderation/check.ts:30,63,81,89`：类型和关键词扫描支持 `negativePrompt`，AI 分支却仅检查/发送 `input.prompt`。
- `src/app/api/generate/route.ts:137-140` 已把负向提示词交给共享审核；遗漏发生在共享函数，而非调用方。
- `src/lib/generation/parse-generate-request.ts:136-142,165-170`：Canvas 文生图和普通 JSON 请求保留该字段。multipart 图生图会设为 null，因此不能声称所有 UI 提交都可复现。
- `worker/internal/worker/generation.go:146-147`：`/images/generations` 真实请求携带 `negative_prompt`。Responses 图片工具不发送该字段，不能把该发现扩大到该分支。
- 触发：关键词未命中的任意负向文字，通过 JSON 或 Canvas 文生图请求。正向文字送审，负向文字直到上游才被看到。
- 最小修复：共享审核构造带清楚字段标签的正向与负向文本，保证覆盖实际文字；同时让负向文本参与是否需要 AI 审核的判断。无需复制两个调用方的逻辑。
- 回归：用无害标记填两个字段，断言审核请求包含两者；模拟审核服务只对负向标记返回拒绝，验证普通与 Canvas 均不入队、不扣费。

### P1：站内渠道仍能在审核关闭或只有词表时直接放行

- `src/lib/moderation/check.ts:53-59,81,116`：`builtIn` 只参与最近上游拦截次数；`isEnabled=false` 直接允许，`aiEnabled=false` 也最终允许。
- `src/lib/env.ts:207-213` 默认关闭两项审核开关；`src/lib/moderation/config.ts:35-42` 的数据库配置优先，因此默认值不能证明生产当前状态。
- 触发：站内请求 + 总开关关闭，或仅关键词开启且文字未命中。两条创作台路径均可到达任务创建。
- 最小修复：共享入口强制站内请求具备开启且可用的 AI 审核。保持自有渠道的现有产品策略，避免把它误判成站长账号的绕过。
- 回归：表格覆盖总开关关闭、AI 关闭、缺 key/base、空响应/坏响应；站内拒绝不得记作用户违规。普通/Canvas 路由至少保留一条真实共享拒绝后的无任务/无扣费断言。

### P1：有效 JSON 不等于图片真正得到审核

- `src/lib/validators.ts:45-50` 只要求 `flagged` 为布尔、`category_scores` 非空且分数合法。`{flagged:false, category_scores:{harassment:0}}` 仍通过。
- `src/lib/moderation/check.ts:196-214` 没有验证关键风险类别或 `category_applied_input_types`。兼容服务若只返回文字审核结果，图片请求也被放行；目前只能通过本地模拟确认接受条件，不能断言真实审核服务正在忽略图片。
- 官方说明：`sexual` 可审核图文，`sexual/minors` 仅文本；未支持的图像类别可以返回 0。当前 `MINORS_THRESHOLD=0.02` 不能被解释成识别图片年龄的保证。应至少确认图片请求的 `sexual` 类别实际涵盖 image，文字请求具有必要文本类别。[OpenAI Moderation 文档](https://developers.openai.com/api/docs/guides/moderation)
- 最小修复：集中校验必要类别与输入类型覆盖，能力缺失按审核不可用处理。不要要求官方不支持的 `sexual/minors` image 输入，否则所有图片都会被拒绝。
- 回归：只有无关类别、缺 `sexual`、图片请求只声明 text、缺覆盖信息均拒绝；完整图文覆盖通过。使用正常合成 PNG，不提交真实违规图片。

### P2：后台提示与默认模型会误导配置

- `src/components/admin/moderation-config-form.tsx:145` 仍写“上游异常或超时将自动降级放行”，与当前 `check.ts:90-93` 的拒绝行为相反。
- 表单 `:127` 的关闭说明，需随本轮强制站内审核策略一起更新；`aiConfigured` 在 `src/lib/moderation/config.ts:71` 仅表示有 key，不表示能力探测成功。
- `src/lib/env.ts:211` 默认和表单 `:198` placeholder 都是 `text-moderation-latest`。官方模型页当前标为已关闭，且它本来只支持文本。[官方模型说明](https://developers.openai.com/api/docs/models/text-moderation-latest)
- 最小修复：修正失败处理和开关说明，改用现有可用的多模态默认模型提示；修改 env 默认时同时同步 runtime contract、example 与相关测试。数据库模型配置优先，生产旧值须独立核对，不能只改默认就宣称生效。
- 回归：配置测试覆盖默认/数据库优先顺序；组件可见说明不得继续承诺失败放行。无需为纯文案新增复杂测试框架。

## 已核对的边界

- 普通站内参考 URL 通过 `readSiteImage(url,user.id)`，Canvas 先经 `readCanvasRunInputs` 核验归属，再调用 `readCanonicalSiteImage`（`src/app/api/generate/route.ts:126-143`）。二者都在创建任务前取得原字节送审。
- 本次上传原图从同一 `fileSourceImages` Buffer 送审和持久化（route `:122-124,142,252-259`），没有发现先审缩略图再提交原图的路径。
- Canvas 提交事务再次锁定并核对输入 URL 身份（`src/lib/canvas/run-submission.ts:80-93`）；精确重放返回已存在 run，不新建未审任务。
- 自有渠道普通外链不预读审核，但 route `:110-111` 有功能开关且保持 custom 模式。该差异本身不是站长渠道绕过；Worker 的凭据选择由另一份研究覆盖。
- `readSiteImage` 的旧图读取要求精确归属/精选或用户历史引用，并限制本站 S3 路径；受管理图片读取不回退旧图路径（`src/lib/storage/site-image.ts:44-70`）。

## 未证实风险，不作为已利用漏洞

- **动图/格式覆盖**：普通 multipart 仅要求 `image/*`（parser `:65`）；Canvas WebP 验证明确接受 `ANIM/ANMF`（`src/lib/canvas/image-container.ts:155-165`），PNG 允许 ancillary chunks（`:54-56`），因此未拒绝所有动画容器。尚无证据说明审核与生成上游对这些格式/帧的处理存在可利用差异；如果审核正常报错，现有异常拒绝会阻止继续。若产品只需要静态图片，最小可验证策略是审核前拒绝动画和未支持格式，或审核/生成共用同一静态化字节；不能只规范化审核副本。测试应使用合成安全动图。
- **旧对象可变性**：历史 S3 参考图先读取审核，Worker 后读取相同 URL；URL 相同本身不能证明字节不变。不过正常上传采用唯一随机 key，未发现普通用户覆写该对象的入口；受管理读还有摘要校验。因此这是旧存储/管理员外部覆写能力的残余风险，不能冒充已确认的普通用户绕过。若以后支持可变外链，应先形成不可变快照再审查与提交。

## 建议执行范围

优先共享审核的关闭条件、实际文本覆盖与类别/模态验证，再同步后台说明和默认配置。动画处理应在明确支持格式后共享实现，不给 Studio/Canvas 各加一套。已有来源授权、计费与 Canvas 事务约束保持不变。

## 本分工实施与验证

- 新增 `src/lib/moderation/images.ts` 的 `assertModerationImages`：逐图检查 20 MiB、真实格式与声明 MIME、GIF/WebP 帧数；复用既有 PNG/JPEG/WebP 容器验证，并单独拒绝 APNG 动画 chunk 和动画 WebP 标志。使用原字节，不生成替代图片。它是格式/容器检查，不声称完整解码或对每一帧审核。
- `sharp` 从 Next 的间接可选依赖提升为精确 `0.35.5` 的生产依赖；没有升级版本。指定离线安装因 registry 元数据缓存缺失失败，随后固定同版本正常安装成功。lock 仅增加直接引用及必要的 optional 标记变化。
- 敏感词检查新增 `NFKC` 和 Unicode `Cf` 清理。四条真实失败回归覆盖全角、零宽/软连字符、中文/负向文字，保留英文子串不误伤。
- 后台说明改为关闭/失败暂停站内生图，修正模型提示，并解释站内色情 0.20 与未成年人文本 0.02 的限制，不承诺图片年龄识别。
- red：既有词表 4 项、后台提示 1 项失败；新增图片 suite 因 helper 尚未创建而未能加载。green：`moderation-images.test.ts`、`sensitive-words.test.ts`、`admin-ui-foundation.test.tsx` 共 3 suites / 35 tests 通过。6 个相关源码/测试文件 ESLint 通过；修改文件及新文件的空白检查通过。
- 共享审核入口、模态/类别 schema 和全量验证由其他分工整合；本分工没有提交、推送或生产变更。

### 交叉检查后的修正

- 发现复用容器校验误带入 Canvas 的 8 MiB 上传上限。给 `verifyCanvasImage` 增加可选 `maximumBytes`，默认仍为 Canvas 原值；审核 helper 显式传入 20 MiB。未放宽 Canvas 上传入口。
- 新回归使用 sharp 生成约 8.27 MiB 的有效静态 PNG，分别验证 Canvas 默认拒绝和审核接受。修改前该回归失败（1 failed / 14 passed），修改后通过；未使用无效字节填充来伪造大图。
- 修正 `src/app/admin/settings/moderation/page.tsx` 页头剩余的“降级放行”旧说明。
- 验证：图片审核、Canvas 存储、Canvas 资源 API、Canvas e2e fixture 和 Canvas contract 共 5 suites / 96 tests 通过；4 个本轮源码/测试文件 ESLint 通过，空白检查通过。本轮未改共享 check、下载器或 Worker。

### images/edits 数量限制收口

- `src/lib/external-api/image-edits.ts` 新增单一 4 张常量，与 chat/responses 上限一致；分别在 JSON 各别名聚合完和 multipart 文件聚合完后检查，早于 `Promise.all`、外链下载和 `File.arrayBuffer`。未修改下载器、限流或其他入口。
- 新增 5 项解析回归：JSON 同字段 5 张、跨全部别名合计 5 张、multipart 跨别名 5 张都拒绝且不发生下载/文件读取；JSON 与 multipart 各 4 张维持合法。先运行原实现得到 3 failed / 2 passed，修复后全过。
- 目标验证：`external-image-edits.test.ts` + `external-v1-routes.test.ts` 共 2 suites / 33 tests 通过；两个相关文件 ESLint 和新旧文件空白检查通过。没有提交、推送或生产调用。
