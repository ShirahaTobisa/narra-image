# sakura 发布记录

- 用户授权：2026-11-20，“推送gh，部署吧”。
- 完成时间：2026-11-20 14:45（Asia/Tokyo）。
- 代码提交：[aeee856](https://github.com/ShirahaTobisa/narra-image/commit/aeee856f96d72cc67f542708a633bb7efc428898)，推送至 `draw-aliya`。
- 作者与提交者：`Mornye <121953903+ShirahaTobisa@users.noreply.github.com>`。
- 网站：https://draw.aliya.moe ，服务器目录 `/srv/narra-image`。

## 发布与备份

核对远程分支、线上版本和本次涉及文件的基线哈希后，直接使用该提交的源码归档构建。归档 SHA-256 为 `9bc9c4e3580111a2ec4cf0c0faf9788d8a7d55b2de5a31690ad730a445c3853a`。

服务器为 4 GB 内存；构建时只给 Dockerfile 的构建命令增加 `CIRCLE_NODE_TOTAL=3` 和 `NODE_OPTIONS=--max-old-space-size=1536`，限制构建资源。这两个设置只用于构建，不进入应用运行环境；仓库 Dockerfile 保持原样，发布镜像保留源码 revision 标签。

- 镜像：`narra-image-app:sha-aeee856f96d72cc67f542708a633bb7efc428898`
- 镜像 ID：`sha256:3268df651b0bc0f054ea3b97aec4cd38180e2de4b67abc88a39f23e1ac13af2a`
- 先在 `127.0.0.1:13001` 试启动，检查通过后将 `.env` 的 `APP_IMAGE` 固定到新镜像，仅更新 app 容器。
- Worker、PostgreSQL 和图片卷保持原实例；迁移状态为 up-to-date，没有执行数据库结构变更。
- 私有备份目录：`/srv/narra-image-backups/20261120-aeee856`，包含源码/原配置、数据库 dump、图片、构建日志和发布回执。数据库 dump 已用 `pg_restore --list` 检查。
- 旧网站镜像保留为 `narra-image-app:rollback-2087e89-aeee856`；没有删除旧镜像或数据卷。
- 临时候选容器已停止并移除。

## 发布后检查

| 检查 | 结果 |
| --- | --- |
| 内部 healthz / readyz | 200 / READY，Worker 与 app 均 healthy |
| 公网首页、登录、注册、领码页 | 全部 200；登录页引用的脚本可读取 |
| 未登录打开创作页 | 明确跳转至登录页；Next 流式响应为 HTTP 200 + 登录跳转 meta |
| 未登录获取生成记录 | 401 JSON 错误 |
| 外站 Origin 提交登录 | 403 JSON 错误 |
| 无效登录参数 | 400 JSON 错误 |
| 公网 healthz / readyz | 既有 Caddy 规则隐藏为 404，规则保持原样 |
| 从当前 Windows 电脑独立访问 | 登录页 200，约 0.207 秒；首页 200，约 0.202 秒 |
| 新容器运行日志 | 检查时没有 error / panic / fatal 行 |

逐项回执见 [deployment.json](./deployment.json)。HTTP 时间仅为这次请求测量，不代表验证码加载或交互性能。未使用真实账号完成登录/验证码、签到/领码或计费出图，不能将 HTTP 检查当作这些操作的端到端验收。
