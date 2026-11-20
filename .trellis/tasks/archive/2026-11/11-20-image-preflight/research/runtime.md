# NSFWJS / WASM 本地运行验证

日期：2026-11-20。任务研究阶段，只写独立临时原型与本报告；没有修改产品源码、package.json 或 pnpm-lock.yaml，没有连接 Sakura/生产数据库。只使用纯色图和主代理已确认无害的站内素材，没有下载、收集或测试 NSFW/CSAM 图片。

## 结论

`NSFWJS 4.4.0 + @tensorflow/tfjs 4.22.0 + @tensorflow/tfjs-backend-wasm 4.22.0` 在本机 Node `v24.21.0` 的独立 Worker 线程运行成功，实际后端为 WASM SIMD，1 个 WASM 线程。MobileNetV2Mid 数据随固定 npm 包提供，运行时只读取本机文件；全程禁用 fetch/http/https/socket/tls 后，加载和推理均成功、网络尝试计数为 0。

**必须保留原生 ESM 模型导入。** 先用 CommonJS `require` 加载官方模型包装，实测冷启动约 4 秒、RSS 峰值 1073 MiB；只把 NSFWJS 两处改成原生 `await import(...)` 后，冷启动约 0.32 秒、峰值 237～266 MiB，预测完全一致。无需改库源码，也无需 tfjs-node。源码的 CJS `__importStar(require(base64String))` 会枚举大型字符串的字符属性，是可定位的额外分配来源；不要让 Next/构建器把 Worker 的原生 import 再转换回该 CJS 路径。

## 固定来源与版本

- 官方当前 npm 版本通过 `npm view ... --registry=https://registry.npmjs.org` 查询；NSFWJS 最新为 4.4.0，TFJS/WASM 最新为 4.22.0。NSFWJS [官方 release](https://github.com/infinitered/nsfwjs/releases/tag/v4.4.0) 与 [npm 包](https://www.npmjs.com/package/nsfwjs/v/4.4.0) 一致，gitHead 为 `d55a54c51f14380670064cc129b2ea51029c5e46`。
- 精确直接依赖：`nsfwjs=4.4.0`、`@tensorflow/tfjs=4.22.0`、`@tensorflow/tfjs-backend-wasm=4.22.0`、`buffer=6.0.3`、`sharp=0.35.5`。sharp 复用产品已有版本，用于图片解码；未安装 tfjs-node。
- `nsfwjs` npm integrity：`sha512-krC1fgeTLXtZwgdpKJ0jm7hqv0gTSRQQRL+FhOaxaJ9Wj92t42BO3csO2odwgTAgZgf2RvkwPtp0R8Aa7dc+MA==`。
- TFJS integrity：`sha512-0TrIrXs6/b7FLhLVNmfh8Sah6JgjBPH4mZ8JGb7NU6WW+cx00qK5BcAZxw7NCzxj6N8MRAIfHq+oNbPUNG5VAg==`。
- WASM integrity：`sha512-/IYhReRIp4jg/wYW0OwbbJZG8ON87mbz0PgkiP3CdcACRSvUN0h8rvC0O3YcDtkTQtFWF/tcXq/KlVDyV49wmA==`。
- 完整依赖树及其它 integrity 保存在独立 `package-lock.json` / `fingerprints.json`。lock SHA-256：`6c71060138554a52c84efa27c48bb994f574d741e5b90ff3960b3239ee8ea895`。

## 模型与 WASM SHA-256

模型源目录：`D:/tools/codex/tmp/narra-preflight-prototype/node_modules/nsfwjs/dist/models/mobilenet_v2_mid/`。权重由已校验 npm tarball 的 bundled JS 取得，没有另用浮动模型 URL。

| 文件/数据 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `model.min.js` | 128625 | `a7a9e701491e2449b221dab7c424957f853e700602b5575da33cfd745616f964` |
| `group1-shard1of2.min.js` | 5593186 | `f2e79a209e44d668220ec5f1533a98f2be954e3953685bf074d201b82fefc29a` |
| `group1-shard2of2.min.js` | 142742 | `f291df992a0131741372506a6072fb9f1645bff7c973c983fd6276f5f9625d5e` |
| 解码后的 shard1 | 4194304 | `70e4519134a0a12417ad80b6c299d8a2b90e52ce389d03d9d56b08df6b7f5b09` |
| 解码后的 shard2 | 106471 | `70f6216b39b52b6f1e31e13683c71987a587dc1a85644adffa17cb48c2e9bee7` |
| 顺序合并后的权重 | 4300775 | `fee38f0bcbad1a223b8301c014bbf78984365aef5ab08fc3289ed4229ab67f0e` |
| `tfjs-backend-wasm-simd.wasm` | 424594 | `77ebb28a6d34f371dbbf2086b7f2de8994acd8ea5a3cf1fa24d2c26c840cac7b` |
| `tfjs-backend-wasm.wasm` | 311123 | `70a5d516060464e5269f01c74bac1772d6b8ab6cb612acf16b5cdaf61f78d892` |
| `tfjs-backend-wasm-threaded-simd.wasm` | 435643 | `c052228d4bef185c27bbe59a9e029570c78bbb9f08b3cb46b597851650373de2` |

WASM 文件来自 `node_modules/@tensorflow/tfjs-backend-wasm/dist/`，通过 `setWasmPaths` 显式指定本机绝对目录。该版本在 Node 下禁用 WASM 多线程检测，实测 `getThreadsCount()=1`；外层 Node Worker 与 WASM 内部线程是两层不同概念。[官方 WASM 加载/路径说明](https://github.com/tensorflow/tfjs/blob/tfjs-v4.22.0/tfjs-backend-wasm/README.md)

## 实测方法和结果

机器：Windows x64，Intel Core Ultra 9 290HX Plus，Node v24.21.0 / npm 12.1.0。每轮新 Node 进程、新 Worker、重新加载模型；37 张图片严格逐张发送，前 5 张作为首次样本，后 32 张统计热请求。耗时包含传入 Worker、sharp 解码/缩放、推理和返回；16 张批次取连续 16 次之和，没有同时解码 16 张。

原图仅复制给 Worker；模型用 224×224 RGB 副本，原图 SHA-256 前后相同。素材为程序生成的白 JPEG、黑 PNG、蓝 WebP，以及 `public/pet/character.png`（1136×1385，1944445 字节）、`public/marketing/home/jiangnan-rain-v2.png`（1448×1086，2638230 字节）。两张站内图 hash 分别为 `13c68e35bbf69ba70b581e77f88dcfd835c4c71ba1a37984ed98d502642a9102`、`f3ded79890deb46ccafe50e13419dcab0626970f6a77790652b221f1e73354d4`。

| 轮次 | 冷 Worker 就绪 ms | 热 P50 / P95 ms | 16 张串行 ms | 进程峰值 RSS MiB | 37 张后 RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原始 CJS | 4011 | 44.5 / 65.5 | 777 | 1073 | 448 |
| 原生 ESM 1 | 318 | 37.0 / 54.8 | 659 | 266 | 260 |
| 原生 ESM 2 | 324 | 37.8 / 61.3 | 708 | 240 | 219 |
| 原生 ESM 3 | 322 | 37.4 / 60.0 | 680 | 237 | 219 |

RSS 是整个 Node 进程（包含主线程、Worker、sharp 与原图缓存），不是单个模型权重大小。启动 Worker 前基线约 59 MiB；峰值由主线程 5ms 定时采样，可能漏掉更短的峰值。ESM 三轮主线程心跳最大间隔约 20～21ms，推理确实在 `isMainThread=false/threadId=1` 执行。每轮模型加载后与 37 次后均保持 109 个 Tensor / 17203104 字节张量，不代表完成长期内存泄漏验证。

5 张无害输入最高类别均为 Neutral；角色图 Neutral≈0.877、Drawing≈0.116，雨巷 Neutral≈0.773、Drawing≈0.226。仅这些无害样本不能评估漏检率、真人照片误判率或校准阈值。黑色纯色的 Hentai 分数约 0.0225，也说明不能把任意极小概率当成违规证据。此验证不建立 CSAM 或年龄识别能力。

## 实际命令与可复制示例

所有原型文件和完整 JSON 回执在 `D:/tools/codex/tmp/narra-preflight-prototype/`：

- `worker.cjs`：实际可运行的 Worker；网络 API 在导入前禁用，原生 ESM 模型导入、本地 WASM、串行推理和 Tensor dispose。
- `worker-cjs-original.cjs`：保留首次高内存路径，便于追溯。
- `example.cjs`：20 行最小入口，生成白色 PNG 并调用 Worker；已执行成功。
- `bench.cjs`：基准入口；`receipt-windows-1.json` 与 `receipt-windows-esm-{1,2,3}.json` 为真实回执。
- `fingerprint.cjs` / `fingerprints.json`：可重算完整 hash。

```powershell
cd D:/tools/codex/tmp/narra-preflight-prototype
# 首次已执行，退出 0，新增 77 个包：
npm install --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
# 重现时使用已保存的 lock：
npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
node example.cjs
node bench.cjs receipt-repeat.json
node fingerprint.cjs
```

模型加载的最小关键代码（必须在独立 Worker 中运行，保留 native import）：

```js
const tf = require('@tensorflow/tfjs');
const wasm = require('@tensorflow/tfjs-backend-wasm');
const path = require('node:path');
const { load } = await import('nsfwjs/core');
const { MobileNetV2MidModel } = await import('nsfwjs/models/mobilenet_v2_mid');
wasm.setWasmPaths(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm')) + path.sep);
wasm.setThreadsCount(1);
if (!await tf.setBackend('wasm')) throw new Error('WASM unavailable');
await tf.ready();
const model = await load('MobileNetV2Mid', { modelDefinitions: [MobileNetV2MidModel] });
// rgb 是 sharp 在 Worker 内生成的 224×224×3 副本；原图另行保留。
const input = tf.tensor3d(new Uint8Array(rgb), [224, 224, 3], 'int32');
try { return await model.classify(input, 5); } finally { input.dispose(); }
```

## Node24 / Alpine 与实施约束

- NSFWJS 4.4.0 官方 `engines` 写的是 Node `22.13.0`、npm `>=10 <12`；本机安装出现 EBADENGINE 警告但退出 0，Node24 真实运行通过。这不等于上游声明支持 Node24。产品若启用 engine-strict，需显式、局部处理并保留验证，不应换整个站点 Node 主版本。
- 已只读确认 Docker context 为 desktop-linux，endpoint 为本机 `npipe:////./pipe/dockerDesktopLinuxEngine`；使用空 Docker config + 固定 endpoint inspect `node:24.22.1-alpine`，因本机 Docker daemon 未运行而退出 1。本轮没有启动 Docker Desktop、pull 镜像或创建容器，因此 **Alpine 尚未实测**，不能将 Windows 通过写成生产 Linux 已通过。
- WASM 不需要 libtensorflow/tfjs-node 的原生 ABI；sharp 仍需要正确的 Linux musl optional binaries，须在目标镜像内安装依赖，不能复制 Windows node_modules。现有产品本就使用 sharp。
- 生产镜像须同时携带选定模型 bundled JS 与 WASM 资源，Worker 用独立未被 Next 打包转换的脚本文件；不在首次用户请求时下载模型。最终 Docker/Node24 镜像必须再跑一次 `example.cjs` 同等无害离线 smoke。
- 单个常驻 Worker 复用一个模型、限制队列和单图解码像素/时间，16 张按顺序推理。不要每图创建 Worker，也不要因为模型只有 4.3MB 就按该值配置容器内存。当前性能来自高性能工作站，不可直接承诺 Sakura 相同延迟；至少为约 270MiB 的额外进程 RSS 峰值留余量，并在目标 CPU 上验证截止时间。
