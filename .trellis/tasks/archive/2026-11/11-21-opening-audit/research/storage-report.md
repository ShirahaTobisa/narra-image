# 开站报告：并发、存储和本机审核复核

审阅范围：报告第 1、7、15 项；当前源码 `da7915a`，产品代码部署版本 `1c50f24`。仅阅读代码和既有测试，没有生产写入、压力测试或产品改动。生产配置由主代理本轮只读核实：Worker 并发 2、每用户活动任务 1、v1 关闭；图片额度 5,000,000,000 字节，清理总开关关闭、quotaCleanupEnabled=true、定时清理关闭；当前 usedBytes=5,090,439、reservedBytes=0。

## 优先结论

| 报告项 | 当前结论 | 优先处理 |
| --- | --- | --- |
| #7 满队列仍先保存参考图 | **成立，明确的资源浪费入口**。最终拒绝不撤销已完成的参考图写入；生产自动清理关闭。 | 把任务名额准入移到参考图落盘前；并发竞争必须仍有原子检查。 |
| #1 两个 Worker、50 MiB/张预留、5 GB 上限 | 限制成立；“同时两张”和固定吞吐量不准确。清理关闭不关闭额度。 | 保留额度和并发；明确排队容量、等待目标和清理运营策略。 |
| #1 排队 30 分钟自动退款 | **不准确**：30 分钟回收由页面/历史查询触发，并非定时队列硬截止；新版未决任务有额外保护。 | 如需要硬等待期限，单独定义并用现有安全补偿条件实现。 |
| #15 第四个本机图片审核请求失败 | 成立，但指同时未完成的请求，不是第四张参考图；属于有意的失败即拒绝资源保护。 | 不提高并发；可单独改善繁忙提示/重试语义。 |

## #7：落盘在名额检查之前

`src/app/api/generate/route.ts:251` 预留输出；`:258` 用 Promise.all 保存全部文件参考图；直到 `:283` 锁 User、`:284` 统计该用户 PENDING/PROCESSING、`:287` 拒绝达到两个任务的请求。`:404` 的失败处理只关闭 outputReservation。

每张图走 `src/lib/storage/managed-image-storage.ts:117` 的独立 INPUT reservation、随机写入身份和实际字节计账；`:184` 完成写入并关闭该 INPUT reservation，`:221` 将其作为 REFERENCE 持久化。关闭 reservation 只释放剩余预留，不删除已记账的 ImageObject。因此两个未完成任务已经存在时，新的合法上传仍可产生无任务引用的 AVAILABLE 图片，然后才返回排队错误。重传同一张图也会创建新的对象，不靠内容去重消除占用。事务余额竞争失败也存在同类后置落盘问题。

新每用户五张/分钟规则没有关闭此入口：`src/app/api/generate/route.ts:118` 使用实际输出 count；图生图固定 1，参考图数量不是额度张数。保持两个任务未完成、窗口恢复后，用户仍可每分钟尝试五次图生图。报告的“单参考图 10 MB、约 3 GB/小时”可作为量级示例，不能当作经过实测的速率或当前真实单图上限。

真实边界：网页 multipart 最多 16 张参考图（`src/lib/generation/parse-generate-request.ts:61`）；这里没有文件 size 检查。内置渠道实际图片审核逐张限制 20 MiB（`src/lib/moderation/images.ts:7`），本机审核同时接纳的原图总预算是 256 MiB（`src/lib/moderation/local-images.ts:9`），所以空队列的一次内置请求也不能通过超过 256 MiB 的总图像输入。输出图生图还另需 50 MiB 预留。外部 images/edits 是 10 MiB/张、最多 4 张，Canvas 单次导入是 8 MiB，不能套用为普通网页上传上限。HTTP/formData 和 arrayBuffer 在上述审核限制之前完成，256 MiB 队列预算不是整个 HTTP 请求解析的内存上限。

这些对象不是永远不能清理，但当前生产不会自动清理它们：`prisma/migrations/20261115180000_image_history/migration.sql:383` 的最新 image_cleanup_reason 要求对象已确认、无历史引用等；`:395` 仍保护 WRITE 对象到 writeExpiresAt，默认租约 1,200 秒。普通 REFERENCE 没有 CANVAS_IMPORT 的七天保护；保护期过后可成为既有清理流程候选。`prisma/migrations/20261115090000_image_retention/migration.sql:402` 和 `:421` 的 quota/schedule 清理均受总 enabled 控制。失败请求关闭 output reservation 既不意味着删除参考图，也不意味着实际占用立即可回收。

### 最小安全修复选项

1. **立即止住稳定复现的最小改动**：在任何输出预留和参考图写入前检查已有未完成任务，保留最终 User 锁内检查。现有两任务时必须零上传、零预留、零扣费。这个预检是有效止损，但两个并发请求争最后一个名额仍可能都先上传；不能宣称完整解决并发孤儿问题。
2. **推荐完整解决名额拒绝后的落盘**：复用已有 external-api 暂存任务方式（`src/lib/generation/external-api.ts:214`～`:298`，`workerManaged:false`），先在短事务原子占任务名额、创建不可领取的 PENDING 任务并扣费；文件写入在事务外；全部成功后短事务绑定原始引用并启用 workerManaged。上传前拒绝的请求不产生文件。前置失败沿用现有一次补偿；启用 Worker 的提交不确定性仍要确认归属，不能盲目退款。只对有此问题的普通网页流调整，Canvas 现有 prepare/commit/replay 保持。
3. **边界**：任何真实 I/O 部分成功后失败仍可能留下无根对象，须交由现有确认身份和清理规则处理；不能直接减 usedBytes、按路径删除，或删掉已有历史引用。不要在持 User/Canvas 事务期间做容量预留或网络 I/O。

锁顺序需一并校正：`src/lib/storage/image-reference-lock.ts:5` 明确要求 reference epoch 先于业务行锁，而网页现有 `route.ts:283` 的 User 锁在 `:290` 的 epoch 之前。调整准入时应让 epoch 在前，沿现有存储 API 的 quota/reservation 顺序工作，不能以扩大事务包裹上传来“解决”竞态。最终添加输入引用时也必须经过 epoch/别名绑定和现有不可变历史根，不能事后撤销已绑定根来当清理手段。

建议回归：已有两个任务的有效 multipart 请求不调用 persist/reserve/charge；最后一个名额由两个并发请求竞争，只有接纳者可进入上传；余额竞争失败发生在上传前；部分上传失败时任务不可被 Worker 领取且只退一次总价；启用 Worker 失败/结果不明沿现有安全恢复；参考图顺序、Canvas replay 和按张计费不变。既有 `generate-route-security.test.ts` 尚未覆盖前两项的真实并发顺序。

## #1：队列、容量和截止时间

- `worker/internal/worker/worker.go:191` 启动 cfg.Concurrency 个消费者，每次领取一个任务；`:447` 只领取 workerManaged 的 PENDING，按 MaxActivePerUser 检查当前 PROCESSING。因此部署值 2/1 是全站两个活动任务、每用户一个活动任务。网页还允许每用户最多两个未完成任务（一个通常等待）。任务可以包含 1～4 张输出：`worker/internal/worker/generation.go:135` 的 image-generation 路径直接传 n；`:230` 的 Responses 路径按张串行调用。不能把所有模型都写成“两张并行”或从源码推导“每张 40 秒、每小时 100 次”。
- `contracts/media/v1/contract.json:5`～`:9` 定义默认额度 5,000,000,000 **十进制字节**、每输出槽 52,428,800 **50 MiB**、最多四输出、默认租约 20 分钟。四张任务先占 200 MiB；输入另按真实字节计账。任务完成后释放未用预算，真实输出继续计入 usedBytes。
- `prisma/migrations/20261115180000_image_history/migration.sql:301` 的 image_account_delta 对 used+reserved 执行额度检查，不参考 policy.enabled。以当前生产 5,090,439 已用字节且无额外参考图计算，最多能再容纳 95 个完整输出槽；96 个不行。真实参考图/历史文件会进一步降低数量。磁盘还剩多少不会自动改变这个数据库上限。
- 五张/用户/60 秒限制防止同一窗口提交两个四图任务，却不是全站排队上限；同一用户跨窗口仍可积累两个四图任务，多用户可以很快填满全局预留。不能以“新限额已上”为由否认容量拒绝。
- `src/lib/generation/job-refund.ts:11` 定义 30 分钟；`:187` 的回收由 create/video 页面、管理员任务页、个人历史列表/详情读取调用，例如 `src/app/api/me/generations/route.ts:14`。v1 仅处理未尝试、未交付且无 nextAttemptAt 的 PENDING；legacy 包括符合截止的 PENDING/PROCESSING。没有这些读取就不是准时 30 分钟回收。Worker 的活动执行超时另由 `worker.go:648` 的 JobTimeout 和 `:1350` 的 PROCESSING 清理管理，Compose 默认是 900 秒，不能混称排队 30 分钟。
- `prisma/migrations/20261115090000_image_retention/migration.sql:391` 的过期 reservation 清理排除仍关联 PENDING/PROCESSING 的输出预留，因此不能以 20 分钟 lease 解释为排队自动释放容量。quota 满时 `src/lib/storage/image-quota-cleanup.ts:12` 申请既有清理并在事务外等最多 10 秒；清理关闭或没有可删候选时仍拒绝。

运营选择应明确：希望的最大排队等待时间、是否启用有预览与引用保护的自动清理、5 GB 业务预算是否合适。提升 Worker 并发会增加上游同时请求/本机负载；增大额度只延后饱和；都不应作为 #7 修复。若需要严格等待期限，应把现有安全 pending 回收接到可靠定时执行并验证补偿/未决保护，而不是缩短 reservation lease 或一律退款。

## #15：本机审核的第四个请求

`src/lib/moderation/local-images.ts:8` 的三个位置是 **一个活动请求加两个等待请求**，`:55` 满后立即拒绝；单个请求可以含多张参考图，内部逐张处理。`:10` 的八秒包括冷启动、排队和全部参考图；还有所有已接纳原图合计 256 MiB 的限制。纯文本 `:205` 直接返回，不启动线程。

四个图片请求在前三个尚未完成时到达可触发；每用户五张和全局多个用户不保证不会出现这种并发。共享审核把它转换为“内容审核暂时无法完成，本次未生成，请稍后再试”，阻止远程审核/生成，不落图、不扣费，也不记违规。旧报告称其第四个请求失败是对的，但它不是绕过或计费错误，也不能假定每组第四个都会失败（前三个可能已完成）。既有 `src/tests/unit/local-image-moderation.test.ts:153` 等覆盖三位置、满额拒绝、预算与清理。

建议保持保护阈值和单 Worker。若用户可用性反馈需要，可将繁忙与违规区分成明确可重试响应；此为接口体验选择，需要贯通共享审核结果和客户端，不应通过自动并行重试、加槽位或失败放行解决。先修 #7 的前置准入，也可减少已满任务用户消耗审核位置。

本批 #7 已采用原子占位方案，具体实现、边界及回归见 [implementation-storage.md](./implementation-storage.md)。审核仍在准入之前；没有为了减少审核负载改变既有审核顺序。
