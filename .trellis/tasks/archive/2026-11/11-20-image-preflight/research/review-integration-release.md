# 共享接入与仅更新 app 发布复核

2026-11-20，trellis-check 独立复核。只读检查产品与发布脚本；未连接生产、未修改产品/部署源码。复核对象是当前未提交的图片预审变更，以及 `D:/tools/codex/tmp/narra-preflight-release.py`、`narra-preflight-package.cjs`；发布脚本后续修改需按文末更新记录再核。

## 门禁接入：未发现本轮绕过或计费顺序回归

- `src/lib/moderation/check.ts:181` 先执行真实格式校验，非空图片才调用 `checkLocalImages`；本地全部允许后才构造远程 JSON 与 fetch。`checkLocalImages` 抛错进入现有不可用分支，不记违规；本地命中直接停止远程请求，并在 `:117` 使用返回的实际模型标识，远程命中仍使用远程配置模型。
- 普通上传、历史引用、Canvas 均由 `src/app/api/generate/route.ts:137` 调用共享门禁。上传文件与已解析的全部引用原字节传入，参考图被拒绝时在 `:145` 返回；输出预留、参考图上传、任务事务分别在后面的 `:245`、`:252`、`:384`。历史图经 `readSiteImage` 验证，Canvas 经 `readCanvasRunInputs` 核对所有权和可用性后读取原图；Canvas 提交前仍重新核对引用 URL。
- Canvas 在 `:106` 已存在 PREPARING 幂等占位，且路由会先记录内存限流计数；因此不能宣传审核前“完全没有状态变化”。占位重放只返回既有任务，不触发新的生图；本次拒绝经 `rejectPreparationResponse` 将准备状态结束，不创建 GenerationJob、不扣费。已有测试验证拒绝后再次提交不会重复执行审核/扣费。
- 外部 `/v1/images/generations`、`images/edits`、`chat/completions`、`responses` 的 legacy 与 gateway 分支分别汇合到 `external-api.ts:184`、`gateway-client.ts:244` 的 `assertExternalGenerationAllowed`。该检查在参考图上传、输出预留、扣费、任务创建/Go 转发前。图片输入都使用解析后的 `sourceImages`。查询/重放接口不会提交新的任务。
- 纯文本不会调用本地图片模块的检查函数；模块导入本身没有创建 Worker。自定义渠道仍按既有开关语义执行，非 Canvas 自定义外部 URL 也仍是原有边界，不能把本次结论扩写为“所有自填外链都已经本机审图”。内置渠道关闭审核或配置无效仍拒绝。
- 新增测试覆盖本机拒绝与异常无远程请求、正确模型来源、16 张等待及原字节顺序、纯文旁路本地线程、格式错误不进入本地模型，并通过真实共享函数验证 legacy 外部服务的副作用截止。对其它入口的共享门禁调用与既有失败回归进行了独立核对，未新增平行门禁。

## 发布脚本：初审两项已修复

1. **完整源码包只校验了部分旧文件。** `narra-preflight-package.cjs:14-16` 的 `baseFiles` 是改动路径加 5 个关键文件；`release.py:165` 却解包完整 git archive。未改动文件若在服务器漂移，prepare 仍通过，完整解包会静默覆盖。最小修正是把 baseline 全部追踪的源码文件按上一部署 archive 的原字节纳入 hash，新增文件保留 null；在 switch 真正替换前重核全部 baseline，避免 prepare/build 间变动被覆盖。现有 `baseBlobFiles` 没有在服务器使用，不能替代部署原字节比较。
2. **运行验证回执只绑定提交，没有绑定实际镜像。** `release.py:114-115` 强制要求 `runtime-checks.json` 的 SHA 与 passed=true，缺文件会失败，这是正确的；但同 SHA 重 build 后可继续接受旧镜像的回执。最小修正是实际 Alpine 运行回执写入 appImageId，并与 `checked_image(APP_IMAGE)['Id']` 比较。截止本次只读检查，tmp 还没有生成回执的脚本，不能把强制读取文件本身作为模型已在目标镜像运行的证明。

### 补丁复核：上述两项关闭

- 新增 `narra-preflight-baseline.py` 先核对上一部署 archive 的固定 SHA-256，再逐个读取全部普通文件的原字节哈希；不做换行归一化。独立执行此本地只读 helper，并和 baseline 的 `git ls-tree -r -z --name-only` 对照：archive **3269 文件 / baseline 3269 文件 / 缺失 0**。`package.cjs:15` 全量引入，`:26-27` 对新 HEAD 路径补 null。`release.py:62` prepare 和 `:150` switch 均重核所有条目。完整基线与 build 期间变动保护已具备。
- `release.py:114-116` 除 SHA/passed 外还严格比较 `runtime.appImageId === app_image.Id`。新增 `narra-preflight-runtime-check.py` 使用 inspected 精确镜像 ID 执行 Node 测试和 benchmark，两条命令退出成功且指标断言通过后才写 passed 回执；记录 SHA、image ID、时间、测试日志和 benchmark 源码哈希。没有提前生成假通过证据。目标 Alpine 实测仍由主代理在 build 后执行。
- 仅运行了本地 Python AST parse（baseline/release/runtime-check 三脚本）和 `node --check package.cjs`，均退出 0；没有执行发布阶段或 Docker 命令。

### 新运行检查脚本的清理边界：已修复

初读 `narra-preflight-runtime-check.py` 时，两个 `docker run --rm` 仅由 `subprocess.run(timeout=60)` 限时，没有精确容器身份和 finally 清理。若测试/原生推理挂起，Python 超时终止的是 Docker 客户端，运行中容器仍可继续占用 CPU/内存；`--rm` 不会主动停止仍运行的容器。

最终补丁已只读复核并关闭：`run_probe` 为每次测试生成随机 owner/name/cidfile，不使用 `--rm`；正常返回、非零退出或 timeout 都进入 finally。非空 cidfile 必须是完整64位ID，inspect 后严格匹配 ID、实际镜像ID、名称、owner标签，并核对无网络/无挂载，随后只对该精确ID执行有20秒截止的 `docker rm -f`。没有按广泛名字、项目或镜像批量清理，不触及原生产容器；清理失败也不会写 passed 回执。`alphaCount/alphaBatchMs` 已和当前 benchmark 协议同步。更新后的 Python AST parse 退出0，未执行 Docker 或生产命令。

无网、只读、无挂卷、无凭据、1CPU/512MiB 限制符合测试隔离边界；它不是生产 app 的资源上限。至此，本次独立复核指出的发布脚本问题均已关闭，剩余事项是主代理实际执行目标镜像的运行验收并保留结果。

## 已核对的发布边界

- package 拒绝 worker、prisma、Dockerfile、Compose、contracts 变动；release 仅 build app，使用 BASE 对应旧 Worker 镜像，并核对其精确 image ID。
- candidate 通过 `compose run --no-deps --pull never` 启动，显式仅绑定 `127.0.0.1:13001:3000`；逐项比较旧 app 与 candidate 的完整环境，挂载名称/目的地也相同。Compose 的 app 启动命令是 Next，`ENABLE_EMBEDDED_WORKER=false`，不会另起嵌入式 Go Worker。
- 切换只修改 APP_IMAGE；先查空队列，try 内停 app 后再 drain，之后仅 `up --no-deps --no-build --pull never app`。切换后校验 Worker 容器 ID、镜像、环境、挂载和端口，数据库容器 ID 不变；没有 up/restart Worker、db 或 migrate 的路径。
- 失败发生于替换源码前会启动原 app；源码替换后先停入口/drain，再删除 manifest 中原本不存在的精确普通文件并恢复源码与原镜像 pin。drain 失败则保持入口暂停和现有 Worker；未执行数据库 restore、卷删除/恢复、Compose down 或全局 prune。数据库与图片 tar 仅备份。
- candidate 执行 `prisma migrate status` 是只读状态检查，不执行 migration。迁移状态、镜像与容器检查缺失时切换不成立。

## 独立验证

执行以下目标测试，未运行完整套件或生产命令：

```text
node node_modules/vitest/vitest.mjs run src/tests/unit/moderation-check.test.ts src/tests/unit/external-generation-service.test.ts src/tests/unit/gateway-client.test.ts src/tests/unit/canvas-generate-route.test.ts --maxWorkers=2
4 files, 145 passed，退出 0。

node node_modules/vitest/vitest.mjs run src/tests/unit/generate-route-security.test.ts --maxWorkers=2
1 file, 14 passed，退出 0。
```

总计 159 项通过。Vite 提示现有 configLoader/native 与 CJS 配置兼容警告，不影响退出码。本报告不替代目标镜像实际模型/资源运行记录，也不证明模型零漏检或具备专用 CSAM 识别能力。

## 附加运行脚本只读检查

已读取最终 `scripts/moderation-image-worker.mjs`、`scripts/lib/moderation-image-input.mjs`、离线夹具/测试与 `research/runtime-benchmark.mjs`。固定 ESM 模型、WASM 本地路径、内部线程为 1、逐图 Tensor dispose、通用错误回包均符合父端协议；离线夹具在导入 runtime 前禁止网络 API，实际良性样本还断言未达本地拒绝线，而不只检查输出形状。

透明图片存在已明确接受的设计调整：Sharp 同一 pipeline 会在 removeAlpha 前对 resize 预乘，因此 alpha 路径先输出受 64MP 限制的 RGB，再另起 pipeline 缩到 224；这会产生最多 192,000,000 字节的中间 RGB，不能继续按普通图的内存峰值估计。实现者报告 Windows Node24 实测冷启动343ms、16张800ms、64MP透明图202ms，普通峰值264MiB、含一张透明图451MiB；补充的16张64MP逐图压力为约3.4秒、630～637MiB峰值，GC可重叠持有多个中间缓冲，不能宣称512MiB容器通过全部最坏批次。本次未独立重跑这些性能测量。该调整已由主代理知悉，仍需目标 Alpine 离线容器的最终回执，不能以工作站数据承诺线上耗时/总内存。没有发现必须扩大产品修改范围的新问题。
