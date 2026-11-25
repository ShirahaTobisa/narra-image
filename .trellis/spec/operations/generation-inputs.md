# 生成输入与失败恢复

## 1. 范围与触发条件

修改参考图读取、普通创作台/Canvas 入队、按张计费与限额、审核响应或失败重试时使用。存储写入和生命周期仍遵循 [Image Storage](./image-storage.md) 与 [Media Storage](./media-storage.md)。

## 2. 签名

- `resolveGenerationCount({ generationType, count }) -> number`：文生图使用请求张数，其余类型固定 1；扣费、限额、输出预留和任务必须共用该值。
- `calculateGenerationCost({ providerMode, builtInCreditCost, count })` 与 `hasEnoughCredits({ ...同前, credits })` 的 `count` 必填且为实际输出数；内置单价乘张数，自填渠道为 0。
- `assertGenerationRateLimit(userId, count)`：同步检查并占用每用户滚动 60 秒 5 张额度，超额抛 `ApiRateLimitError`（429）。底层 `tryRecord(key, count = 1)` 超额不写入。
- `startExternalGeneration(args) -> Promise<{ result: Promise<Job> }>`：先完成 API/图片限额准入，再启动生成；流式入口先 await 此包装，再开始响应并等待 result。普通 `runExternalGeneration` 复用它，不提供跳过限额参数。
- 公共模型准入与 `/v1/models` 复用 `mergeChannelsForUsers` 的明确名称集合；通配渠道仅为已公开模型兜底，不能让客户端任意模型名称通过。普通 JSON 无参考图的图生图/图生视频在解析时拒绝；Canvas 使用自己的规范输入分支。
- `readSiteImage(url, ownerId, options?) -> Promise<SiteImage | null>`：客户端传入的 URL 必须经过授权读取；`null` 表示不属于允许的本站图片。
- `readCanonicalSiteImage(url, options?) -> Promise<SiteImage>`：仅供 `readCanvasRunInputs(ownerId, run)` 已核验拥有权后的内部结果使用，不能直接接收客户端 URL。
- `SiteImage = { data: Buffer; mimeType: string }`；`options = { maximumBytes?: number; signal?: AbortSignal }`。
- `parseGenerateRequest(...)` 返回原有 `images`、`imageUrls`，并携带 `imageInputOrder: ("file" | "url")[]`。
- `checkGenerationInput({ userId, prompt?, negativePrompt?, images?, builtIn? })` 在入队前审核实际文本和原图字节；外部两条链路共用 `assertExternalGenerationAllowed`。
- `moderationResponseSchema` 校验 `{ results: [{ flagged, categories, category_scores, category_applied_input_types? }] }`。
- `assertModerationImages(images)` 校验静态图片，不改写字节；`verifyCanvasImage(bytes, declaredType, maximumBytes = CANVAS_LIMITS.importBytes)` 的调用方应显式选择自己的大小边界。
- `checkLocalImages(ReadonlyArray<{ data: Buffer | Uint8Array; mimeType: string }>)` 返回 `{ blocked: false }` 或 `{ blocked: true; category: "sexual"; score: number; model: string }`；故障抛错，由共享审核转为不可用。
- `fetchPublicHttpUrl(url, { signal?, redirect?: "manual" })` 固定到已验证的公网 IP；默认拒绝跳转，manual 调用方必须逐跳重新调用此函数。

## 3. 输入与边界

- 网页、Canvas、外部 API legacy / gateway 用进程级共享用户图片限额；API Key / endpoint 不能拆分额度。Canvas replay 在图片限额之前返回。已有请求次数防刷和 API 每 Key / 每日限制仍独立保留。
- 图片额度在有效请求解析和功能检查后、审核/存储/扣费前占用；已接纳但后续失败的尝试仍占本次窗口。限的是提交图片数，不是异步完成时刻；当前单进程部署重启清零，多实例前须换共享存储。
- 文生图 `count=4`、单价 5 时预扣 20；参考图数量与输出数量无关，图生图即使请求 `count=4` 也统一输出 1、扣 5。视频沿用单任务价格。事务仍要求余额至少为总价，失败补偿只按记录的总额执行一次，不追扣历史任务。
- 受管理图片继续使用现有签名、可用性、存储读取和校验规则，读取失败不得退回旧图片分支。
- 历史 data URL 仅接受 PNG/JPEG/WebP/GIF；旧 S3 URL 必须匹配 `S3_PUBLIC_BASE_URL` 或 `S3_ENDPOINT/S3_BUCKET` 的完整 origin 和目录边界。拒绝凭据、query、fragment、编码路径穿越。
- 旧图片还须精确匹配数据库：当前用户的成功结果、成功的精选结果，或当前用户的历史参考图。仅域名匹配不能授权。
- 默认最多 20 MiB、15 秒；远程读取使用 `fetchPublicHttpUrl`，保留公网地址检查、DNS 固定和禁止重定向。旧 S3 使用唯一且不覆盖的对象 key；不得把此入口推广为任意可变远程 URL。
- Canvas 先确认拥有权并读取参考图，再调用共享审核；提交事务仍复核输入身份。审核失败不得创建任务或扣积分。
- 普通网页在保存新参考图和输出预留前，短事务按 reference epoch→User 顺序取得队列名额、复核账号/归属/余额，并创建 `workerManaged:false` 的预备任务；上传在事务外。最终更新必须匹配 PENDING、未退款、未取消及 workerManaged=false，再绑定输出预留并交给 Worker。Canvas 沿用原 run 提交，不套第二层预备流程。
- 预备失败使用 `failGenerationJobAndRefund({ onlyUnmanagedPending:true })`；占位回执丢失按预分配 jobId 检查，启用回执丢失不得退款或关闭已交付任务的预留。部分上传失败不等于能立即删除未知或仍有引用的图片对象。
- Worker 首次上游发送前检查账号封禁，确定未发送时按 `GENERATION_CANCELLED` 收尾和一次补偿。批次首张已发送后不再以新封禁错误退整个任务；取消和参考图输入错误不计入渠道失败连续次数。
- 站内渠道必须启用总开关和 AI，且配置、密钥、模型、阈值有效；关闭审核表示暂停站内生成，不能降级成只查词库。自定义渠道保留原有可选开关语义。
- 同一用户最近24小时的 `ContentReview` 明确违规（仅 `sensitive_word` / `ai_moderation`）与内置渠道 FAILED `GenerationJob` 的明确安全拒绝合计达到3次后，后续站内审核入口直接暂停；不再调用审核或新增违规记录。两个查询共用时间边界，按各记录 `createdAt` 计算；任何计数查询故障均返回审核不可用，不透传异常。
- `ContentReview` 没有渠道字段，不能假称只计内置来源：该用户的头像、公开署名和可选自填渠道审核产生的明确违规也计入。头像与署名使用同一强制审核入口；自填生成仍保持原有开关语义。预审拒绝立即返回、不创建生成任务，每次仅写一条审核记录，因此不会与上游拒绝重复计次。
- 后台「内容风控与拦截中心」与上面的计数同源：拦截明细把 `ContentReview` 和上游明确安全拒绝的任务按时间合成一个列表（类型 `provider`），违规榜两者按人合计，最近24小时满3次的标为暂停中并排在最前。上游拒绝的查询条件只在 `check.ts` 的 `PROVIDER_REFUSAL_WHERE` 定义一处，暂停计数和后台页面共用；页面搜索词必须放进 `AND`，不能覆盖该条件自带的 `OR`。
- 管理员可在该页手动暂停或解除暂停某个账号的站内提交（`PATCH /api/admin/users/[id]/pause`）：`User.generationPausedAt` 非空即暂停，提示 `MANUAL_PAUSE_MESSAGE`，不查次数也不送审；解除时清空它并写 `User.moderationClearedAt`，这之前的拒绝不再计入24小时计数（自动暂停一并解除），拦截记录本身保留。手动暂停的账号即使没有拦截记录也必须出现在违规榜上，否则无处解除。
- 生成请求（网页和开发者 API）在前面几道都过了以后跑预审（`precheck.ts`，PRECHECK_* 三项都配了才跑）：问一个能看图的大模型会不会被出图渠道拒，图生图附最多 4 张缩到 1024 的参考图；出错或超时放行。拦下记 `ContentReview` kind=`precheck`（category 存理由），不计入暂停和封号。
- 从最近一次成功出图、管理员解除暂停或解封之后算起，本站明确拒绝加上游拒绝连续满 5 次自动封号（`CONSECUTIVE_REFUSAL_BAN_LIMIT`）；本站拒的当场封，上游拒的在下一次提交时算到。管理员解封同时写 `moderationClearedAt`，计数清零。
- AI 输入包含完整 prompt 与 negativePrompt，后者标明“需要排除的内容”；敏感词仅做 NFKC 和不可见格式字符归一化，不能靠词库替代 AI。
- 审核 `results` 至少一项；每项 `flagged`、`categories.sexual` 和 `categories["sexual/minors"]` 必须是 boolean；两个对应分数必须存在，所有分数均为有限 0～1 数字。这些布尔值只用来确认响应完整，不参与判定：拒不拒只看分数。
- 图像必须明确被 `category_applied_input_types.sexual` 的 `image` 覆盖；有文字且返回覆盖字段时，sexual 和 sexual/minors 都必须含 `text`。旧纯文本响应可以省略整个覆盖字段。官方 omni 的 sexual/minors 仅支持文字，不能声称它识别了图片人物年龄，也不能要求该分类返回 image。
- 任一分类分数 `>= aiThreshold` 才拒绝，站内和自填渠道相同，不能再加比后台阈值更严的隐藏线；唯一例外是 sexual/minors：`categories["sexual/minors"]` 为 true 就拒，与阈值无关（不再用固定分数线：原来的 `0.02` 在开站当晚把成年角色的描述也拒了；用审核接口实测，当晚被拒的 5 条重新打分为 0.02～0.11 且模型均未标记，模型自己标记的一条是 0.20）。旧的 sexual `min(aiThreshold, 0.2)` 和「分类被标记就拒」在 2026-11-21 开站当晚去掉：阈值 0.7 时被拒的 8 条分数全在 0.7 以下，后台的阈值等于没用。无效响应/超时不记录用户违规。
- 参考图接受实际 MIME 匹配的静态 PNG/JPEG/WebP/GIF，单图最多20 MiB；拒绝动画/多帧，避免只审首帧。审核与生成使用同一份字节。Canvas 默认8 MiB 边界不能隐式应用到普通/API 图片。
- 审核故障必须以 `moderation_failure` 记录失败阶段（image_validation/local_image/remote_text/remote_image）、耗时、图片序号、受限格式/字节数及固定错误码/HTTP状态。只记录已知类型，禁止原始错误消息、提示词、图片、文件名、账号、密钥、URL或上游响应；诊断不改变审核判断和故障拦截。生产回归必须调用打包后的审核函数，单独运行源脚本不能证明网页链路正常。
- 图片格式/标记不符、动图、超限、损坏使用明确的输入提示，不能误报为可稍后重试的审核服务故障；仍拒绝本次提交且不计违规。下载名统一为下载时的毫秒时间戳，后缀必须跟随已识别的 Blob MIME（代理按实际字节识别），避免把 WebP/JPEG 保存成 PNG 后重传被拒；代理下载请求携带时间戳，避免缓存旧文件名。
- 图片通过格式校验后，先逐图本机预审，全部通过才能构造远程审核请求；本地通过不免除远程审核。远程审核接口一次请求最多收 1 张图（多张直接返回 400），多张参考图要逐张带着文字各发一次，任一张被拒即拒绝。带图请求里的文字要先单独送审一次（纯文字请求体），再和图片合并送审，任一次拒绝即拒绝：合并送审会拉低文字的分数（2026-11-21 实测同一段提示词 sexual/minors 单独 0.11、带图 0.02，单独会被模型标记的一句带图后不再标记），只合并送审等于带一张图就能绕过文字审核。普通最多16张、外部API最多4张，上传/历史图/Canvas实际字节共用门禁。纯文本不初始化本地模型；自定义渠道仍遵循已有开关语义。
- 本机固定 `nsfwjs/MobileNetV2Mid@4.4.0` 与 TFJS/WASM 4.22.0：五类 Drawing/Hentai/Neutral/Porn/Sexy 分数必须完整且有限，均在0～1。Porn或Hentai `>= aiThreshold`、Sexy `>= max(aiThreshold, 0.8)` 拒绝（Sexy 不算露骨，线不低于0.8，阈值调严时普通人像才不会被误拒）；这些是业务阈值，不是校准概率或未成年/CSAM识别。`ContentReview.aiModel` 使用实际本地模型标识，不能写成远程模型。
- `scripts/moderation-image-worker.mjs` 保持原生ESM导入所选模型，不能经Next转换成CJS；模型/WASM随固定依赖进入镜像，不在请求时下载。CJS包装会枚举大模型字符串，实测多分配约800MiB。Node24/Alpine需用目标镜像实跑，不能忽略上游engine声明差异后只靠类型检查发布。
- 进程级共享一个Node Worker，1活动请求+2等待请求，已接纳请求原图压缩字节共256MiB。8秒整批截止包含排队/冷加载/全部图片；同时检查绝对截止，不能只依赖定时器回调顺序。该预算不包含路由读入但尚未送审的HTTP文件。
- 每次只复制当前图片到Worker，不转移/修改调用方原Buffer；64MP解码上限，WASM一线程，逐图释放输入Tensor。活动超时/错误终止Worker并清空待审预算，旧线程退出前不得另开，退出后退避1秒；等待超时单独移除。空闲Worker unref。
- `readModerationRgb` 应用EXIF方向；有alpha时先在独立管线去alpha输出有界RGB，再缩224×224，防止Sharp先缩放预乘而丢掉隐藏RGB。普通图直接缩小；透明图中间缓冲最多192MB，连续大图可能因GC重叠有更高峰值，不能把单图测试RSS当整站预算。只对分析副本这样处理。
- 外部 URL 下载最多10 MiB、3次跳转、总计10秒；计时覆盖 DNS、连接和完整流式正文。每跳重新查公网上游并固定连接 IP，超限、取消、无正文状态都关闭原响应，不做检查后再次解析的 fetch。images/edits 与 chat/responses 一致最多4张；JSON/multipart 各别名合计，下载/读取文件前拒绝超量。
- DB 审核行优先，环境变量兜底；首个 PATCH 创建行时先继承 `MODERATION_*` 再合并 patch，避免未修改开关被 DB 默认关闭。Compose 必须传入全部7个变量，默认模型是 `omni-moderation-latest`；环境默认不会覆盖现有 DB 行。
- Worker 将明确的 HTTP/JSON/SSE 安全拒绝归一为 `PROVIDER_POLICY_REJECTED` 和固定 `moderation_blocked` 消息，不保留原始正文、不自动重试。仅当拒绝完整结束且无已生成图片时可作为已确定失败补偿；SSE 缺终结、解析失败、批次已产图时保留 v1 UNKNOWN 语义。不能把所有同名错误码计为违规（历史视频错误也使用它）。
- multipart 按 FormData 顺序记录文件/URL，持久化文件后照原顺序合并；JSON/Canvas 的 `imageInputOrder` 为空，Canvas 继续使用核验后的输入顺序。
- 前端重试复用 `toReusableGenerationConfig`，保留原参数、渠道类型和参考图；凭据取当前已授权配置。原图不可用须显示错误，不能悄悄转成文生图。
- 渠道健康查询在 `take: 3` 前排除 `GENERATION_CANCELLED`，同时保留 `errorCode: null` 的历史任务。

## 4. 校验与错误

| 条件 | 结果 |
| --- | --- |
| 当前窗口已占 4 张，再请求 2 张 | 429，不扣费、不预留、不提交；剩余 1 张仍可提交 |
| 总价 20，余额 19 | 网页 402；事务扣款同样校验总价，不留下已接受任务或扣款 |
| 外部链接/他人的非公开旧图 | reader 返回 `null`；内置生图拒绝，下载返回 403 |
| 图片超限 | `SiteImageError`，413 |
| 本站对象响应失败/缺少 body | `SiteImageError`，502 |
| 已清理或不可用的受管理图片 | 保留 `ImageStorageError`，不回退 |
| Canvas 内部输入不是可读本站图片 | `SiteImageError`，403；响应 `private, no-store` |
| 审核字段缺失、类型错误或越界 | 审核不可用；不入队、不扣费、不增加违规计数 |
| 站内审核关闭、密钥无效、图片覆盖缺失、动画图或超时 | 同样按审核不可用拒绝；后台文案不得称“降级放行” |
| 本机队列/字节超额、解码超限、分数缺项、线程启动/推理失败或整批超时 | 同样按审核不可用拒绝；不发外部请求、不记用户违规；实际超时须终止线程 |
| 明确分类/分数/词库命中 | 记录一条 ContentReview 并拒绝；与上游明确安全拒绝合计，24小时达到3次后暂停后续站内提交 |
| 违规计数查询失败 | 审核不可用，不放行、不新增违规，不泄漏数据库异常 |
| SSE 只有 refusal.done 后 EOF，或存在损坏帧 | 不认定整次响应已确定结束，不对未知/部分生成作完整退款 |
| 下载内容不是支持的图片字节 | `/api/proxy-image` 返回 415 |

## 5. Good / Base / Bad

- Good：先选历史图 A，再上传 B，审核两图后仍按 A、B 入队；失败重试继续保留两图。
- Good：本机确认拒绝A，立即停止；不再调用远程审核/生成，记录本地模型；本机允许则继续现有远程审核。
- Base：单张生成的请求格式与价格保持不变；多图总价按张相乘。
- Good：4 张占 4 个图片名额、扣 4 倍单价；Bad：只给请求次数加 1 或把参考图数量当收费张数。
- Bad：放宽成整个 CDN 都可下载；只审核提示词却提交 Canvas 图片；用当前草稿覆盖失败任务的参数。

## 6. 必测断言

- `credits.test.ts`、`rate-limit.test.ts`、`generation-rate-limit.test.ts`：4 张总价、余额边界、图生图/视频单输出、自填零价，4+2 拒绝后再加 1、精确 60 秒过期、用户隔离、并发接纳和模块重载共用计数。
- 网页/Canvas/API/gateway 路由与服务测试使用真实计费函数；断言任务总价、余额、输出数量和 429 无副作用，Canvas replay 不重复占图片额度，跨入口/跨 Key 共用用户额度。退款覆盖总额 20 和重复/未决状态。
- `site-image.test.ts`：本人/精选/历史引用授权、非本站地址拒绝、读取限额、受管理错误不回退。
- `generate-route-security.test.ts`、`canvas-generate-route.test.ts`：实际参考字节送审、拒绝后不入队/扣费、混合参考图最终顺序。
- `generate-route-admission.test.ts`：满队列不预留/上传、并发最后名额、预备不可领取、取消/封禁与两种回执丢失；`job-refund.test.ts` 覆盖只退款尚未交付的预备任务。真实 Worker DB suites 覆盖 legacy/v1 封禁前零上游请求、一次退款，以及首张发送后正常完成。
- `avatar-route.test.ts`：每用户5次/60秒限频先于解析，200 KiB头像的原始字节经同一严格图片审核后才存储；审核拒绝/故障不得更新头像。公开作品仍不展示账号头像。
- `proxy-image-route.test.ts`：已授权旧图下载与内容识别；`moderation-check.test.ts`：关审、缺项、coverage、负面词、分数上限、损坏响应和无害正例。
- `moderation-check.test.ts` 还需覆盖真实查询过滤条件、站内2次加上游1次、三次分别明确拒绝后第四次暂停、纯图片/署名文字同一门禁、单次多结果不重复记录、过期/其他用户/未知kind/普通失败排除，以及计数/模型/配置/服务故障不记违规。
- `moderation-images.test.ts`：真实静态四格式、动画/伪装/损坏拒绝、8～20 MiB 普通图片允许且 Canvas 原限额保持；`moderation-config.test.ts`：首次 PATCH 保留环境开关。
- `local-image-moderation.test.ts`：阈值边界、五类完整性、原图/顺序、16张串行、全局单例、队列/256MiB预算、排队/活动截止、晚到ready/result、线程退出前禁止重建、故障后预算回收；阻止分数使用合成响应，不收集违法图片。
- `moderation-check.test.ts` 与 `external-generation-service.test.ts`：真实共享入口在本地拒绝/错误后无fetch/存图/扣费/入队；纯文本不调本地，拒绝记录真实模型。`scripts/tests/moderation-image-worker.test.mjs`：真实模型无害正例、解码/透明RGB边界、像素上限，在目标Node24/Alpine且无网络容器内通过。
- `external-source-images.test.ts`：DNS 重绑定与挂起取消、逐跳公网、慢正文/未声明超大正文有界退出、无正文状态销毁；不依赖真实外网。
- `worker/internal/worker/provider_safety_test.go`：HTTP/JSON/SSE 安全拒绝、普通错误不误判、部分结果和未完整终结不误退款。
- `generator-studio-origins.test.tsx`、`parse-generate-request.test.ts`：原参数重试、混合输入、切换会话与提示词下限。
- `admin-channels-provider.test.ts`：取消任务既不造成失败，也不遮住真实失败历史；SQL NULL 数据继续参与。

## 7. Wrong / Correct

```ts
// Wrong：文生图 count=4 仍按一次请求收单价。
// Correct：计费、任务和输出预留使用同一个实际张数。
const count = resolveGenerationCount(body);
const cost = calculateGenerationCost({ providerMode: body.providerMode, builtInCreditCost, count });
assertGenerationRateLimit(user.id, count);

// Wrong：丢失参考图顺序，也不能据此确认图片经过审核。
const sources = [...uploadedUrls, ...body.imageUrls];

// Correct：保留解析阶段的顺序；授权和审核在入队前完成。
let fileIndex = 0, urlIndex = 0;
const sources = body.imageInputOrder.map((kind) =>
  kind === "file" ? uploadedUrls[fileIndex++] : body.imageUrls[urlIndex++]);

// Wrong：关掉总开关后，仍用站长账号生成。
if (!cfg.isEnabled) return { allowed: true };

// Correct：先维护站内强制审核，再处理其他渠道的可选行为。
if (builtIn && (!cfg.isEnabled || !cfg.aiEnabled)) return unavailable;

// Wrong：同一主进程 require 大模型，或本机放行后跳过远程检查。
// Correct：独立、未被打包改写的 Worker 原生导入；结果仅作为前置门禁。
await assertModerationImages(images);
const local = images.length ? await checkLocalImages(images) : { blocked: false };
if (local.blocked) return local;
// 然后才构造和发送完整远程审核请求。
```
