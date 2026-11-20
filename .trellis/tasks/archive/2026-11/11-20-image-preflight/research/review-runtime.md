# 图片预审运行脚本独立审阅

2026-11-20，trellis-check。只读审阅最终运行脚本、解码 helper、真实模型测试、禁网 fixture、CI 接线与固定依赖；未访问生产或使用违规素材，未修改产品代码。

## 结论

未发现需要阻止合并的产品问题。运行脚本与父端单活动协议相符，无需再加一套队列。实际 Alpine / Next 生产包验证仍由主代理完成，以下结果不替代它。

## 核对依据

- `scripts/moderation-image-worker.mjs:5` 使用原生 ESM 的 `nsfwjs/core` 和单个 Mid 模型入口，避免加载其余模型。安装包的 `dist/esm/model_imports/mobilenet_v2_mid.js` 仅动态导入本地模型 JSON 和两个固定权重模块；固定模型名走本地 JSONHandler，没有下载 URL。WASM 路径由本地 `require.resolve` 得出，启动前固定 1 线程；禁用 fetch/http/https/net/tls 的 fixture 下实际加载及推理均通过。
- `scripts/lib/moderation-image-input.mjs:7` 对原始解码设置 64,000,000 像素上限，读取 metadata 也受限。透明图先应用 EXIF 方向、转换 sRGB 并去 alpha，完成 raw 解码后才创建第二管线缩小，避免 resize 提前预乘透明 RGB。第二管线尺寸取自受限第一管线；sharp 的 raw 默认 uchar，sRGB 去 alpha 后与 3 通道声明一致。无透明图直接缩小。上游格式/动画拒绝仍在共享 `assertModerationImages`，该 Worker 不是独立外部入口。
- `scripts/moderation-image-worker.mjs:32` 每图仅创建 224×224×3 张量，`finally` 释放输入张量。已核对固定 NSFWJS 实现：中间推理使用 `tf.tidy`，成功后释放 logits；异常由父端关闭整个 Worker。`local-images.ts:103` 只在上一张已结束时发下一张；消息处理完成前不会发生本请求多图并行。仅副本传入 Worker，原图字节与顺序不变。
- `package.json:41` / lock 固定 TFJS、WASM 4.22.0 与 NSFWJS 4.4.0；lock 仅新增依赖项，没有改动既有锁定版本。Docker 从冻结锁安装，复制完整 node_modules、scripts、public，并在 `/app` 运行，覆盖本地模型/WASM/测试素材路径。`scripts/verify-ci.mjs:25` 与 `:45` 均接入真实模型测试。
- 已核对安装包许可元数据：NSFWJS MIT、TFJS/WASM Apache-2.0；主代理补入的 `THIRD_PARTY_NOTICES.md:262` 起包含对应固定版本说明和许可正文，Docker 同时复制该文件及原有依赖内许可。

## 独立执行

```text
node --test scripts/tests/moderation-image-worker.test.mjs
node node_modules/eslint/bin/eslint.js scripts/moderation-image-worker.mjs scripts/lib/moderation-image-input.mjs scripts/tests/moderation-image-worker.test.mjs scripts/tests/fixtures/image-worker-offline.mjs scripts/verify-ci.mjs
```

真实模型 7/7 通过，定向 lint 通过。Node v24.21.0 / Windows；此次冷启动 381 ms、16 张串行 881 ms、结束 RSS 234 MiB（不是峰值）。覆盖真实离线加载、损坏图恢复、全透明隐藏 RGB、EXIF 6 方向、超过 64MP 拒绝、完整分数及无害素材低于业务阈值、原图未改写或 detach。

发现一个非产品测试空洞：透明/不透明图只比较两次结果的 `.scores`，两次都报错时也会相等。已通知实现代理，建议先断言两次 `error === undefined` 再比较分数；不需增加生产分支。无害素材测试不能证明违规检测率或人物年龄识别能力。
