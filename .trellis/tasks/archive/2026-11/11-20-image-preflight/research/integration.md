# 本机图片预审：共享入口与资源边界审阅

2026-11-20。仅研究与设计审阅，未改产品代码/依赖，未连接生产，未使用违规图片。已读本任务 PRD/design/implement 与 generation-inputs、quality-guidelines、release-hardening 规范。

## 建议的最小接入

在 `src/lib/moderation/check.ts:184` 的原图容器验证后、构造远程审核请求前，加一次仅在 `images.length > 0` 时执行的本机预审。所有图片通过后才继续当前远程审核；任一图片拒绝即整单拒绝，不必继续处理剩余图片。纯文字路径不调用本机预审、不创建 Worker、不导入 TensorFlow/模型。

保留目前的站内审核总开关/AI 配置门禁。配置不全时直接不可用，不能因为本机模型可运行而跳过远程审核。自填渠道仍按既有可选审核语义处理，不扩成未经要求的全站强制配置。

建议只增加一个服务端 Worker 管理模块和一个独立 `.mjs` Worker 入口。管理模块保存进程级复用实例、固定容量与请求超时；Worker 内加载固定模型、解码推理副本、逐图分类。不要新增一套生成队列、数据库表、对外服务或配置面板。

### 已确认的调用覆盖

| 入口 | 现有路径与审核顺序 | 本次要求 |
| --- | --- | --- |
| 普通上传/混合历史引用 | `src/app/api/generate/route.ts:118-145` 收集文件和已授权本站原图，调用 check；上传/任务/计费在后 | 审核得到的原始 Buffer，不重新下载 URL，不修改调用方数组 |
| Canvas | 同一路由 `readCanvasRunInputs` / `readCanonicalSiteImage` 后进入 check，提交事务再次核对输入 | 保留拥有权、reservation 失败恢复与重放规则 |
| 外部 legacy | `src/lib/generation/external-api.ts:184` 调 `assertExternalGenerationAllowed`，其后才持久化/扣费 | 同一 `sourceImages` 字节先本机、再远程、再上传 |
| 外部 Go gateway | `src/lib/generation/gateway-client.ts:244` 同上；扣费/上传/HMAC 转发在后 | 不另在 Go Worker 加模型或绕开共享入口 |

自填渠道的非 Canvas URL 引用在 `route.ts:130` 不会作为站内原图读取，因此此共享接入不能宣传为“所有自填远程图片也经过本机审核”。这是既有自填渠道边界；当前核心目标是保护站内账号。

## 审核记录不用迁移，但必须带对来源

- `prisma/schema.prisma:141` 的 ContentReview 已有 `kind`、`aiModel`、`aiScore`、`category`。继续 `kind="ai_moderation"`，可被现有后台筛选/统计直接显示，无需增加 kind 或迁移。
- 目前 `check.ts:116` 一律写 `aiModel: cfg.aiModel`。本机拒绝若直接复用当前 outcome，会被误记为 OpenAI；这是实施时必须一起改的小点。
- 给拒绝结果带一个准确的模型标识即可，例如 `nsfwjs/<实际模型>@<固定版本或模型摘要>`；远程拒绝仍带实际远程模型。写 ContentReview 时用结果中的模型来源，不从全局远程配置猜。
- category 使用本机实际分类；不要伪装成 `sexual/minors`、人物年龄结果或专用 CSAM 检测。后台 `moderation-reviews-board.tsx:346` 已显示 aiModel，无需重复做一套记录 UI。
- 超时、模型损坏、线程退出、无效结果和容量满均走现有审核不可用分支，不写违规记录、不继续远程请求。只对明确本机拒绝写一条记录。

## 最小资源方案

建议先用固定常量，不增加多组运维开关：每个 Next 进程一个复用 Worker，最多一个活动请求和两个等待请求，已接纳的整请求原图总字节最多 256 MiB；具体是否适合 Sakura 仍以本轮真实 CPU/RSS 测量为准。纯文字完全不参与这些许可。

1. 申请按**整请求**计费的内存/请求许可：累加每张 `data.byteLength`，先检查容量，再加载/复制。等待项只引用现有原图，不能提前为整批复制或解码；申请失败立即返回不可用。
2. 活动请求在同一个 Worker 内逐张推理，只复制当前图片。不要 `Promise.all(images.map(classify))`，不要把整批 16 张一起 postMessage。
3. 全请求截止从申请许可开始，覆盖排队、冷加载与整批推理。排队超时移除等待项并释放许可；活动超时先将该实例标记不可复用，拒绝本请求，再真实终止 Worker。旧实例退出前不能连续创建替代线程，否则超时只会堆积后台推理。
4. error、messageerror、没有结果的 exit（包括 code=0）、构造/postMessage 同步失败均只能结算一次。清理定时器、监听器和容量；迟到结果按请求 ID 和 Worker 身份忽略，不能让旧 exit/error 清掉新实例。
5. 模型正常时缓存复用，失败时清掉失败加载状态；不在同一生成请求里无限重试加载或自动跳过本机检查。一个 fatal 错误可直接拒绝该实例上的等待项，让下个新请求重新尝试，避免复杂恢复队列。

### 实际容量陷阱

- **原有普通上传最多 16 张，不是 4 张。** `parse-generate-request.ts:61` 限制 16；外部 edits 才是 4。必须保留 16 张能力，测试末张拒绝；256 MiB 容量只影响过大的整批，不得偷偷只审前几张。
- **压缩字节不等于解码内存。** `moderation/images.ts` 校验20 MiB、MIME与容器，但没有本任务自己的像素预算；容器函数明确不分配解码像素，也不应用额外尺寸上限。新增解码使用明确 `limitInputPixels=64_000_000`，只对推理副本 resize 后再 raw 输出，禁止先把全分辨率图转成 Tensor。
- **256 MiB 不是整个 HTTP 进程的内存上限。** 路由在调用 check 前已经读取/下载图片；上述预算约束本机预审已接纳请求及其额外复制。已有请求解析、Sharp 解码、WASM、模型、Next 自身均另占内存，需记录峰值 RSS，不能只报 JS heap。
- **WASM 自身也有线程池。** 在初始化后端前显式设为一个线程，并核对实际线程数；不能以“一个 Node Worker”推断只占一个 CPU 工作线程。[TensorFlow.js WASM 官方说明](https://raw.githubusercontent.com/tensorflow/tfjs/master/tfjs-backend-wasm/README.md)
- **Worker 的 resourceLimits 不是原生内存隔离。** 它不限制 ArrayBuffer 等外部数据；全进程仍可能 OOM。保留字节/像素/队列限制，不能靠一个 heap 配置宣称安全。[Node 24 Worker 文档](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)

## 原图与模型结果完整性

- 原图 byteLength、每个字节与调用方顺序必须保持。给 Worker 的当前图片使用独立副本；不得将调用方 Buffer 的底层 ArrayBuffer 放进 transferList，也不能按整个 `.buffer` 忽略 Uint8Array 的 byteOffset/byteLength。
- Node 文档说明 transferable ArrayBuffer 会让发送方相关视图失效，Buffer 池还可能涉及整池复制；`terminate()` 异步完成，应以实例退出确认资源槽可复用。[Node 24 Worker 文档](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)
- 解码、旋转/颜色与小图缩放只在 Worker 内生成推理副本；远程审核、上传和 Worker 生图仍拿原图。不要用缩略图替代原图发给远程审核。
- NSFWJS 输出五类；取完整结果并验证所有预期分类唯一、分数有限且在0～1，缺失/无效不能当作0通过。不能仅凭最高类别是 Neutral/Drawing 就忽略其他分类的拒绝分数。阈值按固定模型明确作为本站策略，不从宣传准确率推导安全保证。[NSFWJS 官方项目](https://github.com/infinitered/nsfwjs)
- 本机模型不提供专用 CSAM/年龄证明。图片包含人或儿童本身不是拒绝依据；真实验证仅使用明确无害图片，模拟输出覆盖拒绝条件。

## 运行产物与最小验证矩阵

当前 Docker runner 复制 `scripts/` 和 `node_modules/`，不复制 `src/`。独立 Worker 入口可放 `scripts/` 并从打包依赖读固定模型/WASM；不能引用只在开发机存在的 TS 源码路径。若模型另放目录，必须明确 COPY，记录版本/来源/摘要，阻止请求期间远程拉取。Windows Node 成功不能替代 Node24 Alpine 构建后的真实执行。

| 回归 | 必须观察的结果 |
| --- | --- |
| 纯文、负面文字但无图 | 正常远程文字审核，本地构造/模型加载次数为0 |
| 两图全部无害、16张末张拒绝 | 所有通过才发远程；末张拒绝时无远程、上传、扣费、任务 |
| 本机命中 / 远程命中 | 记录正确 aiModel/category/score，来源不会互换 |
| 模型缺文件、加载失败、推理异常、NaN/缺类别 | 不可用，不记违规，不发远程 |
| 队列/256MiB饱和、排队超时 | 无新复制/模型任务，许可准确释放，下一请求可恢复 |
| 加载/推理超时、exit=0/非0、error后exit | 调用有界结束，旧 Worker 被终止，迟到消息不影响后续请求 |
| 非零 byteOffset 视图、PNG/JPEG/WebP/GIF | 送审/上传原图精确不变，容器/动画拒绝仍有效 |
| 64MP边界、正常大照片/二次元无害图 | 不全量展开后再缩图；峰值RSS与耗时有回执，不把普通图生图整体关闭 |
| 普通上传/历史/Canvas、外部legacy/gateway | 本机拒绝沿既有失败恢复路径退出；Canvas无新任务扣费，reservation能正确结束 |
| 生产构建产物离线无害推理 | 入口/依赖/模型/WASM均来自本机，证明无网络加载；记录冷/热耗时和主事件循环响应 |

本审阅没有安装或运行选型模型，也没有量测目标服务器性能；阈值、截止时长和最终容量须由本轮兼容性/性能实验确认。研究结论支持共享最小接入，不代表实现或发布已经验收。
