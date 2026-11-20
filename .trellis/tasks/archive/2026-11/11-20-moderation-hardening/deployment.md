# Sakura 审核加固发布

2026-11-20 17:58（Asia/Tokyo）完成，沿用用户“推送gh，部署吧”的发布授权。

- 代码：[b318b6e](https://github.com/ShirahaTobisa/narra-image/commit/b318b6e3ac72f9081764c1cb09f5914e04d52519)，已推送 `draw-aliya`。
- 作者与提交者均为 `Mornye <121953903+ShirahaTobisa@users.noreply.github.com>`。
- 源码归档 SHA-256：`05acb9a5b7fd9c2cab13743e2fc020a719f231b4d6c4832628cb8a217ed036cb`。
- App：`narra-image-app:sha-b318b6e3ac72f9081764c1cb09f5914e04d52519`，ID `sha256:211927ca1fa5edf6c247322a27c8cb0b707eb08a1feb07e764e17c5e351992c2`。
- Worker：`narra-image-worker:sha-b318b6e3ac72f9081764c1cb09f5914e04d52519`，ID `sha256:2612d7ad3b7f85b5ba06ad8f75f6a371560a1872a99c4be88f9d39b0982c48f1`。

## 备份与切换

私有备份 `/srv/narra-image-backups/20261120-b318b6e` 包含原源码/配置、经 `pg_restore --list` 验证的数据库备份、图片、构建日志、发布脚本、回执和无害审核探测记录。旧镜像保留为 `narra-image-app:rollback-aeee856-b318b6e`、`narra-image-worker:rollback-aeee856-b318b6e`。

基线为上一轮 `aeee856`，33个相关源文件逐项检查。首次对 Git blob 的校验发现上轮 Windows 归档采用 CRLF；确认标准化换行后与 Git 完全一致，再以已校验的上轮发布包原始字节哈希核对生产，保持恢复时可逐字节验证。

App 和 Worker 均从固定提交构建。仅构建用 Dockerfile 将 `pnpm build` 加上两进程构建/1536MiB Node heap 限制，产品文件和运行环境不加入构建参数。候选 App 仅监听127.0.0.1:13001；核对除7项审核环境变量之外的配置完全一致，图片卷相同。数据库审核行优先，当前启用词库+AI、使用官方 omni，原0.7通用阈值保持，新代码对站内 sexual 设0.2上限。

发布前队列为空；停止入口后再次确认排空，再依次更新 Worker/App。`.env` 固定两个新镜像，数据库容器及两个数据卷保留；无迁移，状态 up-to-date。回退逻辑经独立审阅，停止入口及排空失败不替换正在工作的 Worker，源码恢复会精确移除本轮新增文件并校验基线；本次未触发生产回滚。

## 实际验收

| 检查 | 结果 |
| --- | --- |
| App、Worker | 均 healthy，完整启动/运行日志未发现 error/panic/fatal |
| 内部 healthz / readyz | 200 / READY |
| 公网首页、登录、注册、领码页及登录脚本 | 全部可读取 |
| 未登录创作页 | 200 流式响应中明确包含登录跳转 meta |
| 未登录生成记录 | 401 JSON |
| 跨站写登录 / 无效登录参数 | 403 / 400 JSON |
| 公网 healthz | Caddy 既有隐藏规则返回404 |
| 当前电脑独立访问 | 登录200约0.272秒；首页200约0.192秒，仅单次HTTP测量 |
| 正式 App 调官方审核接口 | 无害文字200约300ms；文字+纯色PNG 200约517ms，分类及覆盖字段完整 |
| 任务统计 / API开关 | 仍为2个历史成功任务，无PENDING/PROCESSING；外部API保持关闭 |

详见 [deployment.json](./deployment.json) 与 [live-moderation-probe.jsonl](./live-moderation-probe.jsonl)。探测只用无害固定输入，未进行真实生图、没有用NSFW试探上游，不代表真人登录/验证码/计费生图的端到端验证。模型漏判与账号政策风险无法承诺归零。

候选容器及本次 `/tmp` 上传文件已清理；源码发布目录、镜像和备份均保留。配置密钥未输出到回执或提交中。
