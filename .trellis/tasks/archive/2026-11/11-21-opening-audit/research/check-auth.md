# 独立检查：可选公开署名

结论：当前署名改动未发现需要阻断发布的缺陷，未要求修改产品代码。检查基线为本批未提交 diff（相对 `da7915a`）；auth_research 正追加的“封禁作者作品公开资格”是另一组改动，本报告不把尚未定稿的 guard 当作已验证内容。

## 检查的代码

- `prisma/schema.prisma` 两个 `publicAuthorName String?` 字段及 `20261121000000_public_author_name/migration.sql`。迁移仅给 GenerationImage / GeneratedVideo 加 nullable TEXT，没有回填当前昵称；旧作品因此匿名，旧 writer 省略字段仍兼容。发布顺序须先迁移再启动依赖新列的 Prisma 查询，本次未执行数据库迁移。
- `src/app/api/me/works/[id]/showcase/route.ts`、`validators.ts`、`work-showcase.ts`：投稿只有 `showAuthorPublic` 选择，默认 false；未知客户端 `publicAuthorName` 不进入写入。服务端从鉴权用户取非空 trimmed 昵称，保存的是送审的同一字符串；等待审核期间或以后修改资料不会改变已保存快照。非作者、空昵称、原状态不符、审核阻止/异常不会写入。自动通过走同一校验，不能跳过署名审核。撤回不改变快照；重投会重新选择并覆盖为新快照或 null。
- `src/app/api/admin/works/[id]/review/route.ts:32` / `:44` 与 `batch-review/route.ts:24` / `:43`：先核对管理员页面所见 submittedAt，再以数据库读取的 submittedAt 和 showcaseStatus 条件更新。撤回重投后旧版本单件返回 409、批量跳过；读取后再改变状态也不能成功写入。审批 patch 不含 publicAuthorName，恶意额外字段和后来改名不会替换送审署名。最终版本允许 schema 解析缺省版本，但 undefined 与服务器 Date/null 不相等，旧客户端单件仍明确返回 409 请刷新、批量跳过，不能通过缺字段绕过保护。
- `src/lib/server/works.ts`：mutation target 加载 submittedAt；图片/视频管理列表 DTO 加载 publicAuthorName 和原有 submittedAt。`admin-works-board.tsx` 单件及批量发送实际页面版本，显示作品快照。
- `src/lib/prisma-mappers.ts:298` / `:329` / `:372`：公开图片详情、图片精选、视频精选均只用作品快照，不再回退到当前 User.nickname；公开头像始终 null。图片详情保持显式白名单，不暴露 ownerId/jobId、个人资料、管理备注或审核字段。作者和管理员 DTO 仍保留合法私有信息。
- `work-showcase-controls.tsx`：每次打开投稿默认匿名、未填写昵称不能选择署名；展示预览、发送布尔选择，等待中禁止修改选择，错误留在弹窗。公开详情仍走服务端权限分支和公开投影；视频详情保留已有服务端渲染的访问/提示词行为，没有把完整 video 对象传入客户端。未发现 HTML 原样插入署名的路径。

## 验证

实际执行以下九套定向测试：

- work-showcase-route
- public-author-privacy
- public-work-detail-serialization
- work-detail-page-privacy
- work-detail-panel
- admin-work-image-refresh
- featured-public-contract
- featured-video-serialization
- work-showcase

总计 **127 个断言用例通过**。第一次批量运行八套 118 例通过；work-detail-panel 的测试进程在加载 jsdom 时遇到本机 `UNKNOWN: unknown error, read`，尚未进入测试。单独以一个 worker 重跑该套，9/9 通过。没有产品断言失败。

测试实际覆盖请求 payload、服务端快照、恶意署名字段、昵称改动、默认匿名、自动通过、视频写入、旧审核版本、公开投影精确键、真实页面客户端 props、首页/API 数据一致、作者选择和管理员组件交互。没有把 mock 数据库写入结果当作生产或真实 PostgreSQL 并发证据；未做生产请求或修改。

## 尚未由本次证明的边界

- 旧版本/读写竞争测试使用模拟 target 和 updateMany 结果；未运行同一数据库作品行的“撤回 → 重投 → 旧页面批准”并发集成测试。源码的两层版本条件已核对，建议数据库发布门禁保留该语义；不能用本报告替代真实迁移验证。
- 此轮检查到的是页面 props、API 和组件交互；没有重新捕获部署后 HTML/RSC 原始传输。已有显式公开投影没有扩大字段，但真实发布冒烟仍应检查匿名署名和旧昵称不出站。
- 署名路由已覆盖图片/视频提交，以及视频批量批准；单件旧版本和状态竞争主要以图片案例覆盖。可将现有旧版本用例参数化为两种 mediaType，属于小的测试补强，当前共享分支没有发现视频独有错误。

以上是验证范围说明，不是额外运营规则，也不要求扩大署名功能或重构审核框架。

## 追加检查：封禁公开资格定稿

收到 auth_research 定稿消息后又只读检查 `server/public-work.ts`、server works 查询、图片/视频详情、点赞、ban/unban 的缓存失效和 featured API 缓存响应。未发现新阻断：公开查询共用 FEATURED + 未封禁作者条件；私有访问例外的 viewerId 来自服务端会话，投稿回包也显式传作者 ID。ban/unban 使用 expire:0 失效内部 featured 缓存，对外 API 改为 private/no-store。原始媒体 token 可读性未改，不能将此功能描述为删除公开文件。

实际补跑 `public-work-visibility`、`work-like-route`、`admin-user-ban-route`、最终 `work-showcase-route` 四套 **30/30** 通过（包含与上轮重复的署名路由用例，不与 127 简单相加）。页面原始 HTML/RSC 和真实迁移限制仍如上。
