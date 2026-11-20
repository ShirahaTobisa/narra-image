# 本机图片预审父端独立审阅

2026-11-20，trellis-check。阅读任务设计、check.jsonl、生成输入与发布规范；仅审阅和运行本地模拟回归，未修改产品代码、未请求生产或任何违规素材。

## 结论

在 auth 分工完成截止补丁后的 `src/lib/moderation/local-images.ts` 与 `local-image-moderation.test.ts` 中，未发现需要阻止合并的新问题。父端不需要额外状态机或重复限流层。

## 核对边界

- Worker 路径固定为项目 cwd 下的 `scripts/moderation-image-worker.mjs`。当前 Docker `WORKDIR /app` 且复制 `/app/scripts`；embedded supervisor 的 Next 子进程也固定项目根 cwd。未发现构建产物目录改变该解析基准的代码。真实打包和 Alpine 运行仍由主代理验证。
- `Symbol.for` 存储在 globalThis，防同一 Node 进程重复模块实例分别创建队列。空图输入在创建队列前返回，不启动 Worker；空闲 Worker unref，活动阶段 ref。
- 接纳前检查活动加等待数量最多 3、整个已接纳请求组原图字节合计最多 256 MiB。逐图发送，仅复制当前 Uint8Array 视图范围，不使用原图 transfer list，不 detach 或覆盖原图。
- 每个请求接纳时固定 8 秒截止，含等待、加载和逐图处理；`send` 与 `receive` 在关键状态变化前再次检查 Date.now，不能因 timer 尚未执行接受晚到 ready/result。
- ready 核对固定模型身份；每张图片使用递增 id，重复/旧 id 不会推进下一张。五类分数需完整且有限，策略与设计中的 Porn/Hentai 0.2、Sexy 0.8 一致。
- finish/排队超时逐项释放预算；工作线程异常、消息解码失败、同步构造或发送异常清空全部待审请求与计时器。超时调用 terminate 后保留 stopping 实例，直到 exit 前拒绝重建，防旧线程仍运行时叠加新线程。
- exit 后释放旧监听并设置 1 秒重试延迟；旧实例消息受 runtime 身份和 stopping 检查隔离。terminate 失败也不会主动叠加线程，保持拒绝。

## 独立验证

auth 明确通知最终代码后执行：

```text
node node_modules/vitest/vitest.mjs run src/tests/unit/local-image-moderation.test.ts src/tests/unit/moderation-check.test.ts --maxWorkers=2
```

结果：2 suites / 100 tests 通过（父端 31、共享入口 69）。包括不执行 timer 仅推进时钟的两种晚到消息、故障/预算释放、完整16张检查、原图视图不变、单活动两等待，以及共享门禁无远程 fetch。每个父端用例结束断言无遗留 timer。

此验证采用模拟 Worker，证明父端队列与接线行为；不替代真实模型加载、Next 生产构建、Alpine 内存/耗时、实际 Worker 退出的验证。审阅当时 runtime 脚本仍由另一分工编写，透明图 alpha 处理将在其最终版本另审。
