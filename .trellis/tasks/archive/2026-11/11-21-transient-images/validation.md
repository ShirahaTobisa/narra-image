# 验收记录（2026-11-21）

实现由 Codex 起草，中途额度用完，由 Claude 接手补完并验证。部署结果见本目录之外的发布记录。

## 与 design.md 不同的地方

- 去掉 `GenerationJob_expiry_epoch`。成功收尾的事务本来就先取引用协调锁；给每次状态变化再加一把全站锁，只会让取消任务和收尾互相等待。
- 到期清理只扫 AVAILABLE/QUARANTINED，索引为 `(state,"expiresAt",id)`，五分钟内最多入队一批。否则每秒都会把所有已删除的记录重查一遍。
- 通过审核的上传走 `/media/images/`（可缓存、可出缩略图），待审和已撤下的才走 `/media/gallery-images/`。`TAKEDOWN_PENDING` 期间字节仍按令牌可读，和生成作品一致。
- 临时图片的响应为 `private, max-age=剩余秒数`，不是 `no-store`。
- 上传转为 PRIVATE 时期限用 `date_trunc('milliseconds', …)`。原写法会进位到下一毫秒，下架已通过的作品约三分之二概率被 guard 拒绝。
- `images.localPatterns` 补上 `/logo.png`。漏掉时每个页面都是 500。
- 画布契约不加入本迁移：画布 catalogue 没有变化。
- 管理员的待审列表和计数不含图片已过期的投稿。
- 上传入口改为按钮加弹窗，不再是常驻作品页顶部的整块表单。

## 顺带修掉的线上问题

`scripts/moderation-image-worker.mjs` 用 `require.resolve()` 定位 wasm。Next 会把这个 worker 打进包里，打包后
`require.resolve()` 变成模块编号，`path.dirname(编号)` 抛错，于是线上凡是带图片的请求（图生图、头像、上传）
都被“内容审核暂时无法完成”拒绝。上线前的检查只在容器里单独跑过这个脚本，没有经过 Next 实际调用。
现在改用 `process.cwd()` 下的固定路径，打包与否都能加载。

## 验证

- `tsc`、`eslint`（0 error）、`go vet`、Next 生产构建通过。
- vitest 全量：Windows 上只有 2 个建符号链接的用例因权限失败，WSL Ubuntu 上 `local-image-store.test.ts` 53 个全过。
- `go test ./...`：Windows 上只有 2 个符号链接用例失败，WSL Ubuntu 全过。
- 真库（PostgreSQL 17.12）：`verify:canvas-contracts:db`（91 个，full 与 additive 各一遍）、`verify:worker-contracts:db`、
  `verify:gateway:db`、`verify:migrations` 通过。新增 `image-expiry-db.test.ts`，覆盖到期拒读、清理策略关闭时的
  EXPIRY 清理、活动任务保护参考图、上传的审核与下架。
- 线上库副本演练：在隔离容器内恢复线上数据后执行本迁移成功，旧图 `expiresAt` 为 NULL，本迁移涉及的 catalogue 对象与契约一致。
- 本机整套实跑（Next、Go Worker、模拟上游）：先按线上现状关着开关出图并精选，再对已有卷执行 `--init-image-volume` 后开启。
  旧图和旧精选不受影响；文生图、图生图（站内图和上传文件各一次）、到期后 410、策略关闭时的自动清理、上传、审核、
  点赞、申请下架、下架均符合预期。
- 生产构建实例上的上传探测返回 201，确认打包后的图片审核 worker 可用。
