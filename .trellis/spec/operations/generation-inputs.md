# 生成输入与失败恢复

## 1. 范围与触发条件

修改参考图读取、普通创作台/Canvas 入队、审核响应或失败重试时使用。存储写入和生命周期仍遵循 [Image Storage](./image-storage.md) 与 [Media Storage](./media-storage.md)。

## 2. 签名

- `readSiteImage(url, ownerId, options?) -> Promise<SiteImage | null>`：客户端传入的 URL 必须经过授权读取；`null` 表示不属于允许的本站图片。
- `readCanonicalSiteImage(url, options?) -> Promise<SiteImage>`：仅供 `readCanvasRunInputs(ownerId, run)` 已核验拥有权后的内部结果使用，不能直接接收客户端 URL。
- `SiteImage = { data: Buffer; mimeType: string }`；`options = { maximumBytes?: number; signal?: AbortSignal }`。
- `parseGenerateRequest(...)` 返回原有 `images`、`imageUrls`，并携带 `imageInputOrder: ("file" | "url")[]`。
- `checkGenerationInput({ userId, prompt?, negativePrompt?, images?, builtIn? })` 在入队前审核实际文本和原图字节；外部两条链路共用 `assertExternalGenerationAllowed`。
- `moderationResponseSchema` 校验 `{ results: [{ flagged, categories, category_scores, category_applied_input_types? }] }`。
- `assertModerationImages(images)` 校验静态图片，不改写字节；`verifyCanvasImage(bytes, declaredType, maximumBytes = CANVAS_LIMITS.importBytes)` 的调用方应显式选择自己的大小边界。
- `fetchPublicHttpUrl(url, { signal?, redirect?: "manual" })` 固定到已验证的公网 IP；默认拒绝跳转，manual 调用方必须逐跳重新调用此函数。

## 3. 输入与边界

- 受管理图片继续使用现有签名、可用性、存储读取和校验规则，读取失败不得退回旧图片分支。
- 历史 data URL 仅接受 PNG/JPEG/WebP/GIF；旧 S3 URL 必须匹配 `S3_PUBLIC_BASE_URL` 或 `S3_ENDPOINT/S3_BUCKET` 的完整 origin 和目录边界。拒绝凭据、query、fragment、编码路径穿越。
- 旧图片还须精确匹配数据库：当前用户的成功结果、成功的精选结果，或当前用户的历史参考图。仅域名匹配不能授权。
- 默认最多 20 MiB、15 秒；远程读取使用 `fetchPublicHttpUrl`，保留公网地址检查、DNS 固定和禁止重定向。旧 S3 使用唯一且不覆盖的对象 key；不得把此入口推广为任意可变远程 URL。
- Canvas 先确认拥有权并读取参考图，再调用共享审核；提交事务仍复核输入身份。审核失败不得创建任务或扣积分。
- 站内渠道必须启用总开关和 AI，且配置、密钥、模型、阈值有效；关闭审核表示暂停站内生成，不能降级成只查词库。自定义渠道保留原有可选开关语义。
- AI 输入包含完整 prompt 与 negativePrompt，后者标明“需要排除的内容”；敏感词仅做 NFKC 和不可见格式字符归一化，不能靠词库替代 AI。
- 审核 `results` 至少一项；每项 `flagged`、`categories.sexual` 和 `categories["sexual/minors"]` 必须是 boolean；两个对应分数必须存在，所有分数均为有限 0～1 数字。任一分类 true 都拒绝，不能仅依赖总 flagged。
- 图像必须明确被 `category_applied_input_types.sexual` 的 `image` 覆盖；有文字且返回覆盖字段时，sexual 和 sexual/minors 都必须含 `text`。旧纯文本响应可以省略整个覆盖字段。官方 omni 的 sexual/minors 仅支持文字，不能声称它识别了图片人物年龄，也不能要求该分类返回 image。
- 站内 sexual 拒绝线为 `min(aiThreshold, 0.2)`；sexual/minors 为 `0.02`，与通用阈值无关。这是保守策略，不是概率保证。无效响应/超时不记录用户违规。
- 参考图接受实际 MIME 匹配的静态 PNG/JPEG/WebP/GIF，单图最多20 MiB；拒绝动画/多帧，避免只审首帧。审核与生成使用同一份字节。Canvas 默认8 MiB 边界不能隐式应用到普通/API 图片。
- 外部 URL 下载最多10 MiB、3次跳转、总计10秒；计时覆盖 DNS、连接和完整流式正文。每跳重新查公网上游并固定连接 IP，超限、取消、无正文状态都关闭原响应，不做检查后再次解析的 fetch。images/edits 与 chat/responses 一致最多4张；JSON/multipart 各别名合计，下载/读取文件前拒绝超量。
- DB 审核行优先，环境变量兜底；首个 PATCH 创建行时先继承 `MODERATION_*` 再合并 patch，避免未修改开关被 DB 默认关闭。Compose 必须传入全部7个变量，默认模型是 `omni-moderation-latest`；环境默认不会覆盖现有 DB 行。
- Worker 将明确的 HTTP/JSON/SSE 安全拒绝归一为 `PROVIDER_POLICY_REJECTED` 和固定 `moderation_blocked` 消息，不保留原始正文、不自动重试。仅当拒绝完整结束且无已生成图片时可作为已确定失败补偿；SSE 缺终结、解析失败、批次已产图时保留 v1 UNKNOWN 语义。不能把所有同名错误码计为违规（历史视频错误也使用它）。
- multipart 按 FormData 顺序记录文件/URL，持久化文件后照原顺序合并；JSON/Canvas 的 `imageInputOrder` 为空，Canvas 继续使用核验后的输入顺序。
- 前端重试复用 `toReusableGenerationConfig`，保留原参数、渠道类型和参考图；凭据取当前已授权配置。原图不可用须显示错误，不能悄悄转成文生图。
- 渠道健康查询在 `take: 3` 前排除 `GENERATION_CANCELLED`，同时保留 `errorCode: null` 的历史任务。

## 4. 校验与错误

| 条件 | 结果 |
| --- | --- |
| 外部链接/他人的非公开旧图 | reader 返回 `null`；内置生图拒绝，下载返回 403 |
| 图片超限 | `SiteImageError`，413 |
| 本站对象响应失败/缺少 body | `SiteImageError`，502 |
| 已清理或不可用的受管理图片 | 保留 `ImageStorageError`，不回退 |
| Canvas 内部输入不是可读本站图片 | `SiteImageError`，403；响应 `private, no-store` |
| 审核字段缺失、类型错误或越界 | 审核不可用；不入队、不扣费、不增加违规计数 |
| 站内审核关闭、密钥无效、图片覆盖缺失、动画图或超时 | 同样按审核不可用拒绝；后台文案不得称“降级放行” |
| 明确分类/分数/词库命中 | 记录 ContentReview 并拒绝；上游明确安全拒绝另纳入24小时冷却统计 |
| SSE 只有 refusal.done 后 EOF，或存在损坏帧 | 不认定整次响应已确定结束，不对未知/部分生成作完整退款 |
| 下载内容不是支持的图片字节 | `/api/proxy-image` 返回 415 |

## 5. Good / Base / Bad

- Good：先选历史图 A，再上传 B，审核两图后仍按 A、B 入队；失败重试继续保留两图。
- Base：纯文生图无参考图，原请求格式与计费规则保持不变。
- Bad：放宽成整个 CDN 都可下载；只审核提示词却提交 Canvas 图片；用当前草稿覆盖失败任务的参数。

## 6. 必测断言

- `site-image.test.ts`：本人/精选/历史引用授权、非本站地址拒绝、读取限额、受管理错误不回退。
- `generate-route-security.test.ts`、`canvas-generate-route.test.ts`：实际参考字节送审、拒绝后不入队/扣费、混合参考图最终顺序。
- `proxy-image-route.test.ts`：已授权旧图下载与内容识别；`moderation-check.test.ts`：关审、缺项、coverage、负面词、分数上限、损坏响应和无害正例。
- `moderation-images.test.ts`：真实静态四格式、动画/伪装/损坏拒绝、8～20 MiB 普通图片允许且 Canvas 原限额保持；`moderation-config.test.ts`：首次 PATCH 保留环境开关。
- `external-source-images.test.ts`：DNS 重绑定与挂起取消、逐跳公网、慢正文/未声明超大正文有界退出、无正文状态销毁；不依赖真实外网。
- `worker/internal/worker/provider_safety_test.go`：HTTP/JSON/SSE 安全拒绝、普通错误不误判、部分结果和未完整终结不误退款。
- `generator-studio-origins.test.tsx`、`parse-generate-request.test.ts`：原参数重试、混合输入、切换会话与提示词下限。
- `admin-channels-provider.test.ts`：取消任务既不造成失败，也不遮住真实失败历史；SQL NULL 数据继续参与。

## 7. Wrong / Correct

```ts
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
```
