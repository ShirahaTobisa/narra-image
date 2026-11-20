# 本地图片预审运行侧实现

2026-11-20。仅修改运行脚本、固定依赖及离线测试；未连接 Sakura、生产数据库或外部审核/生图接口，未提交、推送、部署。实际 Alpine 验收由主代理执行。

## 改动

- `scripts/moderation-image-worker.mjs`：独立 Node Worker；原生 ESM 导入 NSFWJS core 和唯一 MobileNetV2Mid，避免 CJS 字符串展开的高内存路径。WASM 只从固定本机包目录读取，内部线程数 1；Sharp 禁用缓存、并发 1。启动发送固定 ready/model，逐张返回五类完整分数或 `{id,error:true}`，不返回原始异常或图片内容；输入 tensor 在 finally 释放。调用端负责单活动请求/超时/重建，Worker 不再造第二个队列。
- `scripts/lib/moderation-image-input.mjs`：64,000,000 像素上限、EXIF 旋转、sRGB、224×224 三通道副本。普通不透明图先缩小后导出 RGB。透明图先独立完成去 alpha/RGB 解码，再缩小，原输入字节不变。
- `package.json` / `pnpm-lock.yaml`：精确加入 `nsfwjs@4.4.0`、`@tensorflow/tfjs@4.22.0`、`@tensorflow/tfjs-backend-wasm@4.22.0`。没有加入 tfjs-node 或 buffer 直接依赖；Node 使用内置 buffer，pnpm 将 nsfwjs 的浏览器 peer 固定为 `buffer@6.0.3`。来源与模型 SHA-256 见同目录 `runtime.md`。
- `scripts/tests/moderation-image-worker.test.mjs` 与 test-only `fixtures/image-worker-offline.mjs`：原生 Node test、真实 Worker/模型、网络禁止夹具；runner 镜像已有 scripts/public/node_modules 即可执行，不依赖 src、密钥、数据库或生产卷。
- `scripts/verify-ci.mjs` 两个固定列表加入本次 Node 测试。

## 透明 RGB 与内存边界

实证：Sharp 0.35.5 在同一管线中，无论 `.removeAlpha()` 写在 `.resize()` 前后，都先预乘 alpha；全透明红/绿/蓝会变全黑。单独使用 affine 也不能保留它。两段 raw 管线确实保留隐藏 RGB，测试直接断言最终模型输入像素，并比对同色不透明图的推理分数。此变更不是把图片铺白底，也不修改最终发送给生图服务的原图。

只有透明图产生全尺寸 RGB 中间缓冲，64MP×3 = 192,000,000 bytes（183.1MiB），不是进程内存上限。主代理已知并选择该最小方案；没有改成额外 PNG 重编码，也没有新增复杂格式解析。Sharp 先读 metadata 检查/分流，超过像素上限的完整合法 PNG 实际被拒绝。

实际产品 Worker 的任务临时 benchmark 位于 `research/runtime-benchmark.mjs`。5ms 采样整个进程 RSS；同一 Worker 严格逐张传图，没有 16 张并行解码。Windows x64 / Node v24.21.0 实测：

| 场景 | 冷加载 | 普通16张 | 透明64MP | 普通阶段峰值 | 包含透明图峰值 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 普通16张后再1张64MP | 343ms | 800ms | 202ms | 264MiB | 451MiB |
| 普通16张后再16张64MP | 341ms | 783ms | 3437ms/16张 | 244MiB | 637MiB |

连续大图可因 GC 时机重叠持有多个 raw 缓冲，不能把单张 451MiB 当作最坏批次上限；第二次独立批次观测为 630MiB。上述是有限无害夹具的采样结果，不是整个 HTTP 服务的内存保证，也不能证明不会有更高瞬时峰值。业务端 8 秒截止/单线程/整请求压缩输入预算由 local-images 管理器实现。实际 Sakura Node24/Alpine、1CPU 性能仍需发布前测量；普通及单大图使用512m smoke，16张64MP压力可另用768m/1g隔离容器记录，不能假报512m通过。

## 已执行验证

```powershell
corepack pnpm --version
# 10.32.1
corepack pnpm add --save-exact nsfwjs@4.4.0 @tensorflow/tfjs@4.22.0 @tensorflow/tfjs-backend-wasm@4.22.0
node --test scripts/tests/moderation-image-worker.test.mjs scripts/tests/ci-prerequisites.test.mjs
node node_modules/eslint/bin/eslint.js scripts/moderation-image-worker.mjs scripts/lib/moderation-image-input.mjs scripts/tests/moderation-image-worker.test.mjs scripts/tests/fixtures/image-worker-offline.mjs scripts/verify-ci.mjs
git diff --check
```

Node 定向测试 11/11 通过（约1.7秒）；单独 runtime 最终 7/7 通过（计外层父测试，约1.5秒）。验证包括：离线真实模型启动、固定协议/五类有限分数、坏图稳定错误后仍可处理无害图、输入未改写/未 detach、透明图实际 RGB 保留与推理成功、EXIF 6 色块位置、64MP 拒绝边界、两张已确认无害站内素材与16张顺序推理。白图、完全穿衣 chibi 精灵表与无人物雨巷图实际 `Porn/Hentai < 0.2` 且 `Sexy < 0.8`；不对任意合成色块追加业务阈值假设。无 NSFW/CSAM 样本。

测试初版的极小2×3 EXIF夹具把两种插值顺序误当成逐字节等价，失败时 Node 的巨大 Buffer diff 格式化很慢；已改为32×48无害色块，验证旋转后的六个实际位置（仅容许 sRGB 通道1级舍入）。没有放松方向功能或修改产品行为。网络 guard 只在测试 Worker 入口，产品不改全局 fetch/http/socket。

NSFWJS 包声明 `engines.node=22.13.0`、`npm>=10 <12`；原型 npm12/Node24 显示 EBADENGINE，实际功能已在 Node24 执行。产品保持 Node24。此次 pnpm10 安装退出0，另提示忽略 `core-js@3.29.1` 构建脚本；没有允许额外脚本，现有运行测试通过。完整类型/lint/Vitest/build/audit由主代理收口。

## Alpine 离线复测命令

固定主代理已构建候选镜像，不挂卷、不传密钥、不连网络：

```sh
docker run --rm --network none --memory=512m --cpus=1 --entrypoint node IMAGE --test scripts/tests/moderation-image-worker.test.mjs
docker run --rm -i --network none --memory=512m --cpus=1 --entrypoint node IMAGE --input-type=module - < runtime-benchmark.mjs
docker run --rm -i --network none --memory=768m --cpus=1 --entrypoint node IMAGE --input-type=module - --alpha-batch < runtime-benchmark.mjs
```

`runtime-benchmark.mjs` 是任务研究文件，可从本机复制到部署临时目录后经 stdin 传入，不需把 `.trellis` 放进镜像。30秒独立截止，输出冷加载、普通16张、可选1/16张64MP透明图耗时/RSS；真实业务截止仍为管理器8秒。主代理须保留成功或失败原始结果后再决定发布。
