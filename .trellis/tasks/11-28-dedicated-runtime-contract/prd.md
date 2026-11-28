# 修复专用模型运行时配置路径

## 问题

线上 H3 实测任务 adb2fe3d-a6f5-4e42-b4f7-1e9ebf788554 在调用上游前失败，错误 PROVIDER_NOT_CONFIGURED / 专用模型配置不可用。`generationContractRoot` 无条件使用 runtime.Caller 的编译源目录，容器内推导为 `/contracts/generation/v1`，实际文件在 `/app/contracts/generation/v1`。Seedream 共用该读取逻辑。

## 要求

- 用最小修改让打包后的 Worker 从运行目录加载现有共享配置，开发测试仍正常。
- 保持配置文件为唯一来源，不复制限制或放宽安全检查。
- 增加能覆盖真实二进制部署目录的回归检查，验证 H3 和 Seedream 的模型配置。
- 修复后推送 GitHub、部署 Worker，并通过网站完成一条正常视频的生成、播放及下载检查。
- 保留现有审核选择、每日名额、计费和上游地址隐藏规则；不创建重复付费任务。

## 验收

- [x] 回归检查能捕获旧路径错误，修复后通过。
- [x] 相关 Go 测试及构建通过。
- [ ] 线上专用模型配置正常，服务健康，视频实测完成。
