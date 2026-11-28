# 专用模型配置路径修复

- 线上 H3/Seedream 都曾在调用上游前报 `PROVIDER_NOT_CONFIGURED`。H3 卡密鉴权和基础模板接口正常；实际提交暴露 Worker 配置定位错误。
- 修复仅增加可执行文件旁配置目录优先读取。目录缺失时保留源码开发路径；已存在的打包目录内容缺失或不可读时报错。
- 新回归先在旧实现下失败；修复后复制测试二进制、脱离源码工作目录，成功读取 H3/Seedream 的共享配置，并验证缺少专用模型文件时拒绝回退。
- GenerationContract/Dedicated/Seedream/H3 定向测试、`go vet ./...`、`go build ./...` 及差异格式检查通过。
- 路径修复 `2e20158` 已部署并同步 GitHub，Worker 镜像 `sha256:2b30b0102c8c7fcaf680fb6c27d8dac291dc59c615ac69e109c73ebbf10dbbd0`，备份 `/srv/narra-image-backups/20261128-contract-2e201581/`。随后实际提交发现 H3 的真实任务号是字符串 `js70cdn18yza`，与文档数字示例不同。
- 已修正 Go 提交/轮询/结果和 Node 视频/封面代理的任务号解析。仅接受 1–128 位 ASCII 字母/数字开头、后续可包含 `_`/`-` 的字符串，兼容正 int64 JSON 数字；保留原任务一致性、主机、凭据、路径和重定向保护。
- 再次验证：Go GenerationContract/Dedicated/Seedream/H3 定向测试、vet/build 通过；两个 H3 Vitest 文件 75 项通过，TypeScript 与受影响 TS 的 ESLint 通过。
- 本站测试任务 `2cc43a75-bf43-46b8-9149-1dcd5d76b67c` 对应上游 `js70cdn18yza`，已通过 by-request 核对提示词、尺寸、时长和请求标识。修复期间暂停 H3 新提交，升级后沿用同一任务和幂等标识恢复，不新建付费任务。
- 待部署完整修复并完成线上视频生成、播放和下载检查。此前站点页面/鉴权检查没有覆盖实际生成；本次明确补齐。
