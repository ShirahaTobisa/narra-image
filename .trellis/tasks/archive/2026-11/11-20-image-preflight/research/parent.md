# 本机预审父线程实现与回归

2026-11-20。实施范围只有 `src/lib/moderation/local-images.ts` 与 `src/tests/unit/local-image-moderation.test.ts`；没有修改共享 check、推理脚本、依赖或生产服务。

## 最终行为

- 导出既定 `checkLocalImages(images)` 与 `LOCAL_IMAGE_MODEL='nsfwjs/MobileNetV2Mid@4.4.0'`。空数组立即通过，不创建队列线程、不加载模型。
- 用进程级 Symbol 保存一个队列，避免多个路由模块各建一个推理实例。最多一个活动请求、两个等待请求，按整批 `data.byteLength` 计算已接纳原图预算256 MiB，容量满时立即失败；不截断16张能力。
- 每个请求一个8秒截止，包含排队、冷加载和整批逐图推理；send（含ready后首图）与result接收都核对同一个 deadline，定时器尚未调度也不能接受超时结果。
- ready 必须声明预期模型。只发送当前图片的独立精确 Uint8Array 副本，不发送 transferList、不读取视图外的字节，不提前复制整批。
- 五类必须完整且全部为有限0～1数值。Porn/Hentai >=0.2 或 Sexy >=0.8 阻断并返回准确模型来源、sexual分类和触发分数；不只看概率最高项。
- 线程/协议/解码错误、构造或发送异常、超时均按不可用拒绝，清掉所有待审请求、计时器和预算。调用 terminate 后保留旧实例到 exit，期间不创建替代线程；退出后1秒退避再允许新请求。
- 正常完成复用线程，空闲 unref；每图独立ID与实例身份检查阻止上一图/旧线程迟到消息影响当前任务。

## 验证

- 初始接口占位版本配合回归：29项中28失败、1通过，见 `parent-red.log`。
- 队列实现后29/29通过，见 `parent-green-first.log`。
- 自审追加“只推进Date.now、不执行timer的迟到结果”回归，先1失败/29通过，见 `parent-deadline-red.log`；加单一deadline检查后通过，再覆盖晚到ready。
- 最终 `node node_modules/vitest/vitest.mjs run src/tests/unit/local-image-moderation.test.ts --maxWorkers=2`：**31/31通过**，见 `parent-green-final.log`。包含阈值边界、五类缺项/NaN/越界、16张末张拒绝、原图不detach/非零offset、队列容量、256MiB预算及释放、冷加载和排队截止、终止尚未退出时禁止重建、正常/异常exit、错误后恢复、同步构造/postMessage错误、旧消息不能跳过下一图；每个用例结束额外断言没有遗留timer。
- 两个文件的定向 ESLint 通过。新文件 `git diff --no-index --check -- NUL <file>` 仅返回正常difference退出1与LF转换提示，没有空白错误诊断。
- Worker 用受控 EventEmitter mock，postMessage 使用真实 structuredClone 模拟复制/转移；分数为合成值，没有真实违规图片，也没有联网。这里证明父端队列和策略，不证明模型准确率、实际Alpine运行或服务器总RSS。

## 限制与交接

- 256MiB约束已接纳预审的原图逻辑总量，不是整个HTTP进程内存上限；每次当前图复制、实际推理和既有入站解析仍需父任务实测。
- terminate 本身失败且未观察到 exit 时保持拒绝，不假设旧线程已消失并叠加新线程。
- 全项目类型、真实本机推理脚本、Linux构建与发布由父任务统一验证；独立审阅交 studio 子代理。
