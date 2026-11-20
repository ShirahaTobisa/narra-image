# 生成输入与失败恢复

## 1. 范围与触发条件

修改参考图读取、普通创作台/Canvas 入队、审核响应或失败重试时使用。存储写入和生命周期仍遵循 [Image Storage](./image-storage.md) 与 [Media Storage](./media-storage.md)。

## 2. 签名

- `readSiteImage(url, ownerId, options?) -> Promise<SiteImage | null>`：客户端传入的 URL 必须经过授权读取；`null` 表示不属于允许的本站图片。
- `readCanonicalSiteImage(url, options?) -> Promise<SiteImage>`：仅供 `readCanvasRunInputs(ownerId, run)` 已核验拥有权后的内部结果使用，不能直接接收客户端 URL。
- `SiteImage = { data: Buffer; mimeType: string }`；`options = { maximumBytes?: number; signal?: AbortSignal }`。
- `parseGenerateRequest(...)` 返回原有 `images`、`imageUrls`，并携带 `imageInputOrder: ("file" | "url")[]`。
- `moderationResponseSchema` 校验审核服务的 `{ results: [{ flagged, category_scores }] }`。

## 3. 输入与边界

- 受管理图片继续使用现有签名、可用性、存储读取和校验规则，读取失败不得退回旧图片分支。
- 历史 data URL 仅接受 PNG/JPEG/WebP/GIF；旧 S3 URL 必须匹配 `S3_PUBLIC_BASE_URL` 或 `S3_ENDPOINT/S3_BUCKET` 的完整 origin 和目录边界。拒绝凭据、query、fragment、编码路径穿越。
- 旧图片还须精确匹配数据库：当前用户的成功结果、成功的精选结果，或当前用户的历史参考图。仅域名匹配不能授权。
- 默认最多 20 MiB、15 秒；远程读取使用 `fetchPublicHttpUrl`，保留公网地址检查、DNS 固定和禁止重定向。旧 S3 使用唯一且不覆盖的对象 key；不得把此入口推广为任意可变远程 URL。
- Canvas 先确认拥有权并读取参考图，再调用共享审核；提交事务仍复核输入身份。审核失败不得创建任务或扣积分。
- 审核 `results` 至少一项；每项 `flagged` 必须是 boolean，`category_scores` 必须非空且全部为有限的 0～1 数字。不完整结果按审核服务不可用处理，不能算通过，也不记录用户违规。
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
| 下载内容不是支持的图片字节 | `/api/proxy-image` 返回 415 |

## 5. Good / Base / Bad

- Good：先选历史图 A，再上传 B，审核两图后仍按 A、B 入队；失败重试继续保留两图。
- Base：纯文生图无参考图，原请求格式与计费规则保持不变。
- Bad：放宽成整个 CDN 都可下载；只审核提示词却提交 Canvas 图片；用当前草稿覆盖失败任务的参数。

## 6. 必测断言

- `site-image.test.ts`：本人/精选/历史引用授权、非本站地址拒绝、读取限额、受管理错误不回退。
- `generate-route-security.test.ts`、`canvas-generate-route.test.ts`：实际参考字节送审、拒绝后不入队/扣费、混合参考图最终顺序。
- `proxy-image-route.test.ts`：已授权旧图下载与内容识别；`moderation-check.test.ts`：损坏的审核结果关闭放行且不计违规。
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
```
