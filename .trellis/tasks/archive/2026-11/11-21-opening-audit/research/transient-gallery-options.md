# 一小时临时图片与上传画廊：最小接入方案

研究范围：用户提出生成结果、参考图一小时后自动清理，长期历史留提示词和参数；画廊保留，改为用户上传后审核，获批作品长期保留，沿用现有 5GB 上限。本次只读代码/规范并写本报告；未修改产品、迁移、依赖、配置，未访问服务器。当前安全发布仍由主代理独立完成；下述是下一步设计，不是已实现或已上线承诺。

## 结论

建议新增独立 `GalleryWork` 上传作品记录，复用既有图片存储、内容审核、投稿状态机和公共卡片，不伪造 `GenerationJob`，也不把 `GenerationImage.jobId` 改成可空去改遍所有生成路径。用户在“我的作品”内上传一张图片并选择是否公开署名/提示词；通过强制内容审核后成为待审作品，管理员批准的那一版才长期保护。

一小时临时存储是存储契约变更，不是把后台 `retentionDays` 改成小数：当前输入根永久保留、保存画布/精选/待审核根阻止删除，Canvas 还有七天宽限。TTL/Worker 主线由 studio 的研究覆盖；本报告重点为上传画廊及其衔接。

## 当前确定的约束与可复用点

| 位置 | 当前行为与影响 |
| --- | --- |
| `prisma/schema.prisma:548`、`src/lib/server/works.ts:23` | GenerationImage 必须属于 GenerationJob；作者、提示词、模型都经 job 取得。不能给用户上传造一个“已成功、费用为零”的生成任务。 |
| `prisma/schema.prisma:747`、`:907` | ImageAsset 独立于业务行保存对象和额度；全站限制是十进制 **5,000,000,000 字节**，不是每用户 5GB，也不是画廊另送 5GB。 |
| `src/lib/storage/managed-image-storage.ts:119` | prepareManagedImageWrite 先 reserveInput，再 beginObject；completeManagedImageWrite 物理写入后确认，UNKNOWN 保持占量。可复用这一链路，不能直接 S3 PUT 或退回数据库 data URL。 |
| `src/lib/storage/image-contract.ts:23`、`prisma/migrations/20261112090000_image_storage/migration.sql:68` | purpose 仅 GENERATED/REFERENCE/CANVAS_IMPORT；独立上传应新增 GALLERY_UPLOAD，用 INPUT 预留，但业务用途不冒充 REFERENCE 或 GENERATED。Node/Go 合同、SQL 校验、catalogue 指纹及 readiness 必须同步。 |
| `src/lib/moderation/check.ts:51`、`:181` | builtIn:true 已包含同用户 3 次/24 小时暂停、敏感词、真实静态格式、逐图本地 NSFW 和远程图文审核；故障拒绝而不记违规。新画廊请求应调用同一入口。 |
| `src/app/api/me/works/[id]/showcase/route.ts` | 现有生成作品投稿只额外审核选择公开的昵称，假定图片来自生成记录。不能把这条 PATCH 直接当用户原图上传审核。 |
| `src/lib/work-showcase.ts` | PRIVATE/PENDING/FEATURED/TAKEDOWN_PENDING 和用户/管理员动作可复用；表结构无需另建一整套审批框架。 |
| `src/app/api/admin/works/[id]/review/route.ts:35` | 管理员须提交看到的 submittedAt，状态+时间条件更新防止撤回重投后旧页面批准新内容。新上传也要保留这一边界，并检查图片尚未到期、确实 AVAILABLE。 |
| `src/lib/server/public-work.ts` | 公共资格是已批准且作者未封禁；当前谓词依赖 job.user，新 GalleryWork 使用直接 user 关系，复用资格含义而不是伪造 job。 |
| `src/lib/canvas/body-limit.ts`、`src/lib/canvas/assets.ts:52` | 已有计数、超时、有界 body 后再解析 multipart 的做法。新入口应提取/复用这个小工具，而非先 request.formData() 再看文件大小。 |

## 建议的数据边界

1. 新 `GalleryWork` 直接包含 `userId`、`mediaAssetId`、实际宽高、创建时间、上述展示状态、提交/审批时间与备注、reviewedById、publicAuthorName 和 showPromptPublic。提示词/负面提示词可选，用户不填就为空；不虚构生成任务、模型、大小参数或费用。若允许填模型，只能标为用户填写的说明，不进入生成渠道选择。
2. 公共 DTO 明确是上传作品，保留现有卡片的图片/作者快照/可选提示词显示能力；无模型时显示“用户上传”，不拿假模型 ID 满足类型。详情使用白名单，不传 userId、邮箱、头像、存储键、审核备注；作者和管理员走授权 DTO。
3. `mediaAssetId` 对应真实 GALLERY_UPLOAD，固定 owner/origin，不允许用户在请求里交一个别人的 assetId 或临时生成 URL 来取得永久保护。**原生成资产仍按原截止时间过期**；用户从本地选择的上传是独立、重新审核、单独计量的对象。
4. 若画廊保留点赞，给 WorkLike 增加明确的 GalleryWork 外键和 `(galleryWorkId,userId)` 唯一约束，或单独小关联表；接口根据真实作品来源做资格检查，不能把上传 id 当 GenerationImage id。仅前端隐藏点赞不是权限修复。
5. 提交字节与公开元数据在这一送审版本中保持不变。改图/改提示词/改变公开署名须新提交并产生新 submittedAt；最简单是上传新记录，不允许对已批准对象原地覆盖。原生 idempotency key 可写在 GalleryWork 的唯一约束并复用预留 intentKey；重放同请求返回同一记录，改 payload 冲突，不重复 PUT/占量/产生两个待审条目。不需另建通用任务队列。

为了不增加过多字段，生命周期截止统一由下一阶段 ImageAsset 的 TTL 字段承载；GalleryWork 只保留审核事实。读/写必须检查关联资产可用性，不能只看 GalleryWork 的状态。

## 最小 API/服务顺序

建议一组清晰入口（名称可沿既有路由风格）：`POST/GET /api/me/gallery-uploads`、作者撤回/下架的 `PATCH /api/me/gallery-uploads/[id]`，以及后台单件/批量审核；公共列表合入现有首页画廊，详情用明确的上传来源适配，避免增加另一整套页面。

POST 每次只收一个文件、可选提示词/负面提示词、showPromptPublic、showAuthorPublic（默认 false）及幂等请求 ID。服务器不接受作者名、ownerId、状态、featuredAt、收费值、远端 URL 或存储键。

推荐顺序：

1. 鉴权并读实时 bannedAt，应用上传限频/有界并发；不要消耗“每分钟生成五张”的预算，不读写积分，不调用 provider。上传频率/每人同时待审数用小的固定上限即可，具体数值由下一阶段验收定，不先凭空增加许多配置项。
2. 有界读取完整 multipart，再检查字段唯一性和长度、真实文件大小/格式；可直接沿审核的 20MiB 单图上限，静态 PNG/JPEG/WebP 为最小支持范围。静态 GIF 是否开放不影响架构；不要承诺 AVIF、SVG、动图。声明 MIME 必须与字节一致，64MP 及本地预审的现有资源上限继续执行。
3. 从当前已鉴权 User 捕获昵称快照；选择公开却为空则拒绝，匿名不带私有昵称。把**实际上传原字节 + 所有将公开/存入投稿的文字 + 选中的昵称**放进一次 `checkGenerationInput({ builtIn:true, userId, images, prompt, negativePrompt })`。可以用有意义的文字标签拼接昵称与可选提示词，不截断；一次明确拒绝只产生一条 ContentReview，不对同一张图先后重复调用独立计数。原始字节校验、本机预审、远端审核均不得由 autoApproveShowcase 绕过。
4. 审核拒绝、不可用或已达 3 次均不写图片、不建待审记录、不预留永久容量；错误沿现有分类，不把审核故障当违规。当前文案写“未生成”，新调用处只需转换成“本次未提交”，无需改变计数协议。
5. 通过后经 managed storage 预留实际字节，再写唯一对象，确认真实回执；不使用头像上传的独立 S3/data URL 保存分支。网络 IO 在业务事务外；对象写成功但业务绑定失败形成受管理的临时孤儿，按同一期限清理。PUT 结果不明不能当未写入、不能立刻返还字节或重试覆盖。
6. 短事务按引用协调 epoch → 相关资源/业务锁的既有顺序复核用户、资产 owner/purpose/AVAILABLE 和截止时间，写 PENDING 及昵称/文字快照。对象回执和投稿绑定须可重放；如果流程中途失败，保持可观察的未决状态并由现有恢复/清理收口。
7. 人工批准时在同一协调锁/资产锁下 CAS `id + PENDING + submittedAt + 未过期 + AVAILABLE`，原子建立持久 SHOWCASE 保护并解除该 **GALLERY_UPLOAD** 的临时截止；不能让通用修改接口把任何临时参考图变成永久资产。清理先赢返回 409 要求重传，审批先赢则清理跳过。

用户说“审核通过长期保留”，不能直接解释成开启自动精选。建议新上传始终进入人工待审，不沿用生成作品的 autoApproveShowcase 自动公开开关，除非用户另行明确同意。无论选择哪种审批规则，严格内容审核都先执行。

## 待审、拒绝和下架的清理规则

| 情况 | 最小建议 |
| --- | --- |
| 格式/内容审核拒绝、审核故障 | 无持久图片；ContentReview 只留明确违规事实，故障不记次数。 |
| 上传写入中/绑定失败 | 有限的临时期限；在途/UNKNOWN 对象按既有确认保护，不能假装已释放容量。 |
| PENDING | **必须有截止时间**，不建立无限期 SHOWCASE 根。最少规则是同样 1 小时；人工审核可能来不及。若希望 24 小时待审，这是合理的单独例外建议，仍须用户确认，不能悄悄永久保护。显示审核截止时间。 |
| 管理员拒绝、用户撤回 | 撤去待审保护并使其立即可清理；可以保留状态/原因元数据，图片不继续作为私有永久相册。通过既有执行器删除、确认后减量，不在 HTTP 请求里直接删文件。 |
| FEATURED | 仅明确批准的这一上传资产长期保留。占用现有全站 5GB；容量满时拒绝新写入，不自动移除精选凑空间。 |
| TAKEDOWN_PENDING | 沿现有下架审核行为保护图片，保持当前“申请后等待管理员”的可见性约定；获准下架或强制下架后释放保护、进入清理。 |
| 作者封禁 | 立即从公共查询/详情/点赞隐藏，缓存立即失效；是否最终删除长期图片是另一运营规则。保持此前“解封可恢复已批准作品”的承诺，不借 TTL 静默改变。 |

任何临时文件都计入同一硬上限。待审短期限仍不能替代上传限频/有界队列，否则攻击者一小时内就能占满 5GB；禁止为待审另开不记账临时目录或第二个容量池。

## 与一小时生成/参考图策略的交叉点

- `image_has_historical_reference` 在 retention migration 第 99 行会查 ImageReference、保存 Canvas、CanvasRun 固定输入、GenerationJob.sourceImageUrls 和 GenerationImage 的 PENDING/FEATURED 状态；最新 history migration 的 cleanup guard 仍调用它。仅加 expiresAt 会一直删不掉。新临时模式须区分历史事实与活跃读取/运行保护，不能删改旧永久输入记录假装没有引用。
- 新上传 GALLERY_UPLOAD 的获批持久根与生成/参考临时根应明确分开；不得通过保存画布、设置封面、旧投稿 PATCH 等入口把任意临时图无限续期。现有生成作品“投稿精选”动作下一阶段应关闭/替换为“下载后上传投稿”，并在服务器拒绝旧 POST/PATCH 提升临时输出的永久性；只改按钮不够。
- 历史已获批生成作品不能在未明确迁移方案时突然消失。可选方案是只读盘点后将其审核/署名快照迁入独立画廊记录并转为受保护对象（同字节复用须明确身份和额度，不重复猜测计量），或要求重新上传。此选择关系到现有画廊和旧 URL/点赞，不应在新生成 TTL 开关里顺手处理；用户要求保留画廊，默认先保留已批准历史展示，另做迁移计划。
- 保存的提示词/参数历史应与图库列表分开：生成历史可以保留图位占位和 generation facts，不能因删除 GenerationImage 行而丢掉参数或计费记录，也不能永远保留 data URL/内嵌原图字符串假称“只留文本”。此处还包括已有未纳管 S3、历史 database fallback 和 Canvas IndexedDB 的语义；TTL 主线需分别盘点，不能从 managed 图数量推断全站都已清。

## 前端与读取到期显示

已有可复用状态：`image-availability.ts` 的 available/cleaned/unavailable、`image-presentation.ts` 的不可用时空 URL、`image-source-presentation.ts` 的参考图投影，以及 `ImageUnavailable` 组件。不要再做第二套“img onError 就当删除”的逻辑。

需要携带服务器固定的 `expiresAt`，显示“一小时内下载 / 到期时间”。到期时，即使维护进程稍后才实际删文件，所有服务器读取和复用入口也应拒绝新访问；不能依赖用户刷新或只靠清理定时任务。DELETED 才是 cleaned；尚待物理清理可用 unavailable + expiresAt 显示“已过期”，不要把它写成已经释放空间。

具体界面：

- `src/components/create/parts/generation-bubble.tsx`、`hooks/use-studio-jobs.ts`、`hooks/use-conversation-generations.ts`：成功生成后展示截止，历史空图位保留提示词/参数；下载、引用、放大到期禁用，纯提示词重用仍可用。停留页面也要更新到期状态，旧轮询不能恢复失效 URL。
- `src/components/works/my-works-board.tsx`、`work-detail-panel.tsx`、`work-showcase-controls.tsx`：图片历史变文本记录，新增明确“上传投稿”，不允许过期图继续走旧生成作品投稿。现有合并逻辑已经保持 cleaned 单调，不应被新查询覆盖。
- `create/canvas/controller.ts`、`renderer-adapter.ts`、`parts/canvas-nodes/reference-node.tsx`、`canvas-image-toolbar.tsx`、`hooks/use-canvas-image-viewer.ts`：保存的画布保留节点和参数，到期引用显示缺图、禁用输出口/下载/复用，提示重新选择本地参考图。不能在前端缓存里继续给旧服务端 URL 可用标记。
- 新“我的上传”与后台审核板：待审剩余时间、过期/拒绝状态、实际送审署名；已批准显示长期保留，无生成倒计时。管理员打开旧页面后过期/被撤回，应看到 409 刷新，不可批准空图。
- `GET/HEAD /media/images/[token]` 当前缓存是 `public,max-age=300,must-revalidate`（route 第 20 行）；临时图应限制为剩余寿命或 no-store，并在 304 分支前验证截止。Next 图片优化缓存、原始下载代理、Node/Go API、内部 `beginRead` 同样要守截止，不能只在卡片隐藏。浏览器已经下载的内容无法远程抹除，这不等于服务端仍长期存图。

## 必须验证的回归

1. 真实上传路由：未登录/封禁、畸形 multipart、实际超长 body、MIME 伪装、多帧、过量像素、NSFW、远端审核故障；均无 PUT/投稿/扣分。用户传 URL、assetId、作者名、status、ownerId 不获准。
2. 真实共享审核：上传一次明确违规只增一条记录，头像/署名/生成/上传共享 3 次窗口；审核不可用不增。自动精选配置即便 true 也不绕过图片/文字审核或意外公开待审上传。
3. 匿名为默认；署名仅用服务器昵称快照，投稿后改昵称不会改变；公开 DTO 无账号/审核/存储字段。上传的可选提示词隐藏时不进入 HTML/RSC。
4. 管理员带所见 submittedAt；撤回重投、替换文字/图、到期与批准并发，旧审核不得放行。批准与清理在真实 DB 竞争，必须只有一方成功，不能产生公开作品指向已删除对象。
5. 真实额度并发：全站剩余量只够一图，两个上传只能有一个取得容量；生成输出/参考/画廊共同使用 5GB；获批图不被容量清理删掉。重复上传请求/丢响应/UNKNOWN PUT 不重复写、减量或发记录。
6. 到期后 GET/HEAD/If-None-Match、原图下载、内部输入读、API 和长期停留页面均失效；物理删除失败仍显示过期且保留占量，重启后继续同一删除任务。提示词/参数和原计费事实不丢。
7. 已批准上传不因一小时 TTL、Canvas 保存/取消或生成历史清理被删；封禁立即隐藏，解封按原策略恢复。旧画廊迁移单独验证 URL/likes/署名/提示词权限，不用一项新上传单测代替。

最少待确认的产品决定只有：待审上传是同样 1 小时还是例如 24 小时、历史已批准画廊的迁移保留方式。实现前应把这两项写入下一任务的验收，其他流程可按上述共享门禁直接复用。
