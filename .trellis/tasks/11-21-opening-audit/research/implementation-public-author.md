# 公开署名与封禁展示实现

按主代理分工及用户“可自行选择”的答复实现。未提交、推送、连接生产或修改账户。

## 行为

- 图片、视频各增加可空 `publicAuthorName`。匿名默认，历史数据不回填当前昵称。
- 作者只提交 `showAuthorPublic` 选择；服务端在新投稿时从已鉴权用户取 trimmed 昵称，空名拒绝，使用 `checkGenerationInput({ builtIn: true, prompt: name, userId })` 审核。客户端伪造名字被 schema 丢弃。匿名不把私有昵称送审/公开。
- 审核前先校验所有权和现有状态；自动通过分支也不能跳过。昵称审核不通过/故障不写投稿。审核等待期间改个人资料不会替换已捕获的快照。
- 私有/管理 DTO 携带 `publicAuthorName`；公开详情仍是原 12 字段白名单，`authorNickname` 改取快照；图片/视频精选的 `authorName` 同样只用快照。没有头像、邮箱或用户 ID 新增公开。
- 审核单件/批量请求带页面所见 `submittedAt`，先比对，再按状态和时间条件更新。撤回重投、读后竞态不会让旧审批批准新名字。部署前打开的旧管理页不带版本，单件返回 409 要求刷新，批量跳过；不会因为 schema 兼容缺省而获准。
- 投稿弹窗默认匿名，有昵称预览、空名说明、审核错误及匿名重试；后台显示实际送审名字。删号确认补充“删除不等于封禁、仍合格的第三方账户可重注册并获赠”，没有改变登录/账号保留策略。

## 追加的封禁公开资格

主代理随后授权最小修复：新增 `src/lib/server/public-work.ts` 共用查询条件 `FEATURED + job.user.bannedAt=null`。

- 图片/视频精选、图片详情、视频 fallback 详情、点赞均使用它。
- `getWorkById(id, viewerId?)` 的可选身份只来自服务端鉴权；作者仍可看私有作品。投稿后读取结果传作者 ID。后台独立查询保留权限。
- 封禁/解封成功后 `revalidateTag("featured-works", { expire: 0 })`。不改作品状态，解封后原已批准作品重新出现。
- 精选接口原匿名响应允许外部缓存 60 秒并额外陈旧回放 120 秒，标签无法撤销这些外部副本。因此外层改为 `private, no-store`，保留原 60 秒可按标签失效的服务端缓存。
- 不撤销媒体 token、不删除图片。浏览器已经收到的页面/图片不会被远程抹除；新的公开数据查询与缓存受此门禁控制。`max` 会回放旧缓存，不能用于本次封禁即时失效；官方行为见 [Next.js revalidateTag](https://nextjs.org/docs/app/api-reference/functions/revalidateTag)。

## 文件

- 数据：`prisma/schema.prisma`、`prisma/migrations/20261121000000_public_author_name/migration.sql`、`.gitattributes`。
- 服务/契约：`src/lib/prisma-mappers.ts`、`src/lib/server/works.ts`、新增 `src/lib/server/public-work.ts`、`src/lib/work-showcase.ts`、`src/lib/validators.ts`。
- 路由/页面：`api/me/works/[id]/showcase`、`api/admin/works/[id]/review`、`api/admin/works/batch-review`、`works/[id]`、`api/works/[id]/like`、`api/works/featured`、`api/admin/users/[id]/ban`。
- 界面：`work-showcase-controls.tsx`、`admin-works-board.tsx`、`users-management-board.tsx`。
- 新测试：`work-showcase-route.test.ts`、`public-author-privacy.test.ts`、`public-work-visibility.test.ts`、`admin-user-ban-route.test.ts`；更新实际页面/后台/投稿交互与相关 typed fixtures。
- 规范：`.trellis/spec/frontend/public-work-data.md` 记录快照来源、审批版本、公开资格及缓存边界。

## 迁移与发布前提

迁移只有两条 `ALTER TABLE ... ADD COLUMN "publicAuthorName" TEXT`，无回填、无约束变更。旧 SQL 未修改。原字节 131 bytes，全 LF；SHA-256：

`630ed573c4a45e329b5c296ef7813eb0a84a4eec0cb12cf227890c36f4a9480f`

`.gitattributes` 固定新迁移 LF。Prisma Client 用显式临时 config、合成 DATABASE_URL、仓库外 cwd 生成成功，不读取项目 `.env`。

主代理发布验收仍须在独立 PostgreSQL 跑迁移：验证两表已有行保持 null、旧写入省略新列仍成立、新字段可读写、数据库约束和 Worker 原写入不退化。先加兼容列再上新应用；应用回滚保留新增列，不回滚数据库/图片卷。

## 验证

- 署名新路由 16 项原实现 14 失败；公开名字 2 项原实现均失败。实现后首次 18/18 通过。
- 署名完整受影响清单最终 14 套 **144/144** 通过（01:34:20 开始），涵盖公开页面 props、首页/API 一致性、图片/视频序列化、作者/管理员界面和旧审批。
- 封禁公开资格新增回归原实现 **7 失败 / 4 通过**；修复后最终 11 套 **96/96** 通过（01:40:32），包括图片/视频恢复、本人私有访问、点赞不写入、封禁/解封缓存、页面与匿名 API 缓存头。
- 旧管理页无 `submittedAt` 的最后兼容提示调整后，状态/路由两套 **50/50** 再次通过（01:42:01）。缺省仍拒绝，单件变为明确 409 刷新提示，批量跳过。
- 全项目 `tsc --noEmit --incremental false` 通过（署名、追加封禁各一次）；目标 ESLint 无 error，早轮 `my-works-board.test.tsx` 有既有 6 条未使用 mock props warning，新增/最终修改文件专项 lint 无 warning。
- 最后缺省版本提示调整后的完整 tsc 也通过。主代理全量首轮发现 `admin-core-operations.test.ts` 的旧批量夹具未提供投稿版本；已补 UI 所见 `submittedAt` 和按 id/状态/时间返回 count 的 `updateMany` mock，未放宽产品校验。该套与署名路由 **24/24** 通过（01:44:50），该文件 lint 通过；全量统一复跑由主代理执行。
- 变更 diff whitespace 检查无诊断；新 SQL/测试 `git diff --no-index --check` 为文件存在差异的退出 1，无 whitespace 诊断。新 SQL 已核对 LF 属性和原字节哈希。

这些是单元、路由、组件和查询契约测试。`public-work-visibility` 明示仅模拟所用 Prisma 谓词，并非真实 PostgreSQL。未宣称执行生产账户/群资格/审核 API 验证，也未宣称浏览器真实 Next HTML/RSC 传输或隔离迁移完成；最终构建、数据库、生产交付由主代理汇总验收。
