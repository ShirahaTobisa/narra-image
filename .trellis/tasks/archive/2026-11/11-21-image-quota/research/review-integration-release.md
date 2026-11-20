# 按张配额：接入与发布独立复核

2026-11-21，trellis-check。核心计费/限流的实施记录另见 `core.md`；本报告独立复核另两位代理的网页/Canvas、外部API/网关接入，以及任务专用发布脚本。未修改他人产品文件，没有连接生产、执行Docker、提交或部署。

## 接入结论：已无阻断项

网页/Canvas和两条服务入口的计数、计费、退款改动未发现新的阻断项。初审确认的公开HTTP契约问题已交给API实现者修复，并完成独立复核：

- **已关闭：legacy保活/流式返回先200、后执行图片配额。** 原 `images/generations`、`images/edits` 将 `runExternalGeneration` 放入 `openAiImageJsonResponse` 回调；Kelivo先返回200流，再把限额错误编码到正文。responses SSE也先返回200/response.created。生成代理先发现并报告，本复核独立读取实际路由确认。最终实现提取 `startExternalGeneration`：先await原API Key限制，再同步接纳用户图片额度，然后返回包含已开始生成Promise的对象；三个路由await接纳后才开流。原run入口复用start，真正执行函数保持模块私有，没有绕过参数，也没有重复接纳。真实路由三种超额负例均验证HTTP429/json/rate_limit_exceeded，且无审核、事务、扣费、存图和上游调用；Kelivo4张成功后其它Key仍可再交1张，证明未重复占额度。独立目标回归已通过。

其它已核对边界：

- 网页鉴权、参数解析、Canvas已提交重放与禁用功能返回先于图片配额。新请求统一求一次实际count；quota之后才验证码、图片读取/审核、输出预留、参考图上传、任务和条件扣费。
- `api/generate/route.ts` 的count同时用于输出预留和GenerationJob；cost同时用于余额预判、事务内credits>=cost条件扣减及creditsSpent。4张单价5是20；图生图/视频固定1，参考图数量不决定输出计费。
- Canvas超额视为已知拒绝，准备行结束为REJECTED，返回带private,no-store的429；未知提交/丢ACK仍走原恢复，不误退款。已提交replay在quota之前返回，不重复占图片单位；原请求次数防刷是独立已有规则。
- legacy外部服务和gateway都先执行原API Key启用/请求限制，再按user.id接纳图片单位，再执行审核。不同API Key不产生新用户额度；任务count、预留count、gateway签名payload.count与扣费全部来自同一个有效数量。
- legacy事务内扣费不足抛错，任务一同回滚；handoff前失败使用原退款流程，handoff后不会再补偿。gateway上传前失败只按cost补偿一次，转发开始后交给原job归属判断；有任务或查询状态不明不擅自退款。
- 共享退款读取实际creditsSpent，并以该金额、refundAppliedAt和状态条件更新来防止重复退款；本次没有复制另一套退款算法。新增测试使用真实20积分值及并发/重复调用验证。
- 测试继续使用真实credits和共享图片limiter，只隔离原请求计数防刷；每例清理global Symbol，保留单独的模块重载共享测试。网页/Canvas、legacy/gateway跨入口共享及4+2拒绝+1允许已有行为断言。

## 发布脚本复核

对象：`D:/tools/codex/tmp/narra-quota-{release.py,package.cjs,baseline.py,runtime-check.py}`。

- 基线为已部署app提交 `ff5dfec7bfad6d153078dcb7d3b04580247f1171`；旧Worker固定为 `b318b6e3ac72f9081764c1cb09f5914e04d52519`，没有错误地把app BASE当作Worker版本。
- baseline helper先验证完整旧包SHA-256，再对全部普通文件保存部署原字节哈希。独立本地只读运行并对照git ls-tree：**archive3300文件 / baseline3300文件 / 缺失0**。package补HEAD新路径null；prepare与switch前均完整复核。
- package拒绝worker/prisma/Dockerfile/Compose/contracts改动。release只build/up app，`--no-deps --no-build --pull never`；切换后比较旧Worker容器ID/镜像/环境/挂载/端口和数据库容器ID。没有Worker/db/migrate重启路径。
- candidate仅回环127.0.0.1:13001，完整环境与旧app一致；审核配置保留，候选执行migrate status而非迁移。runtime回执必须SHA、passed与实际appImageId一致。
- 切换前空队列，try内停app后再次drain；失败回滚先停入口/drain再恢复源码和APP_IMAGE。只删除manifest中原本不存在的精确普通文件；不restore数据库、不删除或恢复图片卷。drain失败保留Worker并暂停入口。
- 新runtime检查从固定stage读src/contracts和测试配置，经stdin注入候选精确image ID里的独立/tmp目录；模型依赖/运行时来自真实app镜像，测试执行的是stage源文件，不能描述成测试了编译后的Next路由。
- 该测试容器无网络、无凭据参数、无host/生产卷挂载、根文件系统只读，仅256MiB临时tmpfs，最多1GiB内存/2CPU。Vitest子进程环境仅保留明确的公开运行变量，数据库/渠道依赖由测试自己的合成环境和mock提供，不使用线上账户。
- 运行180秒子截止和200秒外截止；finally读取随机owner/name/cidfile，校验完整ID、精确镜像ID/名称/owner标签、none网络与仅/tmp tmpfs后，只rm -f该精确容器，另有20秒截止。成功/失败/超时均清理；清理或测试失败不会写passed。
- runtime固定清单已补 `external-v1-routes.test.ts`，目前共9套；真实流前HTTP429负例在external-generation-service里，路由兼容正例也进入候选镜像门禁。

当前发布脚本未发现阻断错误；实际候选镜像运行结果仍须主代理在构建后取得，不以静态审阅代替验收。

## 本地验证与最终结论

- 本轮Python AST parse三脚本及node --check package.cjs均通过；baseline helper只读取本地已核验archive及git，不执行部署。
- 核心实现35项、目标lint与严格局部tsc已通过，见core.md；这是实施自检，不计作另两位代码的独立目标测试结果。
- 独立运行最终网页/Canvas两套：**80 passed / 2 files / 退出0**，回执 `review-web-tests.log`。
- 待API实现者明确产品定稿后，独立运行 `external-generation-service`、`external-v1-routes`、`gateway-client`、`job-refund` 四套：**68 passed / 4 files / 退出0**，回执 `review-api-tests.log`。
- 上述独立入口/退款验证共148项通过；受影响调用方与测试的 `git diff --check` 无诊断。没有将本地测试、合成数据库事务或静态脚本审查描述为生产账户/真实上游验收。

本次检查发现的HTTP429问题已关闭，发布脚本无阻断项；仍需主代理执行完整仓库检查、生产构建及候选镜像实际隔离测试后按既有发布门禁切换。
