# 设计

- 在 credits.ts 提供 resolveGenerationCount({generationType,count})：只有 text_to_image 使用请求 count，其余均为 1。calculateGenerationCost / hasEnoughCredits 增加必填 count，调用者传入实际输出数。任务、输出预留、网关 payload、扣费使用同一个值。
- 通用进程内限流器新增同步 tryRecord(key, count = 1)，检查和写入不可分割；超额不记入。原 isLimited / record 行为保留供登录和早期请求防刷使用。
- server/generation-rate-limit.ts 提供 assertGenerationRateLimit(userId,count)，通过 globalThis + Symbol.for 共享一个 5 张 / 60000ms 限流器，超额抛 ApiRateLimitError。当前单应用进程部署适用；重启重置，未来多实例需共享存储，不能声称分布式保证。
- 网页先鉴权、解析、处理 Canvas replay / 禁用功能，再消费图片额度，后续才审核、预留和扣费。保留现有早期请求次数防刷但不向用户把它称为图片额度。API 先原有启用/请求额度检查，再消费共享图片额度，然后审核。
- 独立审查发现 legacy Kelivo 保活和 responses SSE 会先发送 HTTP 200，再运行限额检查。必须在开启响应流前完成一次准入；通过后继续原有异步生成和保活，不额外消费额度，不提供可跳过限额的布尔开关。
- 被接受后失败的尝试仍占用本次限流窗口；积分按既有失败补偿退回。限额约束提交图片数，不对异步任务的完成时刻作承诺。
- 只修改应用和测试/规范，不改 schema、Worker、依赖或运行开关。应用镜像替换，Worker/数据库容器保持原样；保留原镜像和备份以回滚。
