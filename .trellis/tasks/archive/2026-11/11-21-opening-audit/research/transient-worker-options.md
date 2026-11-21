# 一小时临时图片：Worker / SQL 研究

日期：2026-11-21。只读核查冻结安全版本 `ac29727` 附近的实现；本报告没有修改产品代码、启用开关、连接生产或删除数据。用户已确认保留图生图、图片交付期一小时、图库保留用户上传并审核的作品；旧数据不在本轮自动删除范围。界面与缓存见同目录 `transient-images-options.md`，图库独立模型由另一研究项负责。

## 结论

可以复用现有 managed 图片账本和 Go 清理执行器，但不能把 `retentionDays` 改成小数，或把所有永久引用/Canvas 七天保护直接删掉。最小可靠方案是：**只给新临时资产增加明确的到期时间；公众读取与新任务复用到期即停止；此前已接收的任务继续受保护；物理删除沿用现有带租约、结果确认和额度结算的路径。** 图库持久图片用独立身份和持久位置。保留提示词、参数、费用、任务结果及必要的图片身份元数据，不在这些记录中继续保留新图片的 base64 字节。

“一小时”宜明确为交付/新复用的截止时间。物理清理还要等待已接收任务、正在读取的请求、写入确认等保护结束；不能承诺每个字节在第 3600 秒必然消失。尤其结果不明的任务需要单独解决，不能为满足 TTL 把它改成失败并退款。

## 当前实现证据

| 事实 | 证据与影响 |
| --- | --- |
| 没有图片保留期字段 | `prisma/schema.prisma:747` 的 `ImageAsset` 没有 `expiresAt`。`ImageObject.readProtectedUntil`、`writeExpiresAt`、`deleteExpiresAt` 是操作租约，不能充当图片 TTL。 |
| 当前定时清理按天、按创建时间 | `20261115090000_image_retention/migration.sql:270` 限制 `retentionDays >= 1`；`:421–440` 按 `createdAt <= now-retentionDays` 排队。批次尚在生成时已经开始计龄，不能表达成功交付后的一小时。 |
| 任务输入是永久保护 | `20261115180000_image_history/migration.sql:226` 的 `image_bridge_job_inputs` 写入永久 `JOB_INPUT` / 历史 URL 引用；`:546` 的替换函数不移除 JOB_INPUT。永久行的删除也被触发器禁止。 |
| 只删除引用行仍不够 | `20261115090000_image_retention/migration.sql:99` 的 `image_has_historical_reference` 还直接检查所有任务的 `sourceImageUrls`、Canvas 场景/已提交快照、展台和站点封面；`20261115180000_image_history/migration.sql:607` 会重建已知历史引用。历史事实与物理保留策略必须分开。 |
| 七天是 Canvas 导入图的规则 | `20261115180000_image_history/migration.sql:399–404` 检查 Canvas 绑定、分离时间和 604800 秒保护。不能说所有普通参考图和生成图现在都保存七天。保存的 Canvas/已提交输入还各有引用保护。 |
| 当前活动任务检查主要是生产者 | 同迁移 `:397–398` 检查输出绑定及输出预留的 PENDING/PROCESSING 任务；消费该图的普通任务目前靠永久输入引用保护。放松永久保护时必须补消费任务，否则排队的图生图可能丢参考图。 |
| 有可复用的短读租约 | 同迁移 `:569–587` 的 `image_begin_read` 先锁引用协调行和资产，再保护对象 45 秒；Node/Go 实际读取限时 30 秒。它目前没有到期判断，也没有消费任务身份参数。 |
| FAILED 不总等于已确定结束 | `worker/internal/worker/job_lifecycle.go:579–595` 会同时设置 `status=FAILED`、`handoffState=UNKNOWN`。只凭 status 释放输入保护会错过“上游结果未确认”。本方案不启用或切换 Worker v1。 |
| 现成执行器已处理删除的不确定结果 | `worker/internal/worker/image_maintenance.go:126` 调用关闭预留、排队、领取、实际删除和完成确认；`20261115180000_image_history/migration.sql:483` 仅在确认 DELETED/MISSING 后释放额度，未知结果保留账目。 |
| 旧路径不全在账本里 | `worker/internal/worker/storage.go:107`、`src/lib/storage/persist-generated-image.ts:144` 支持 managed、旧 S3 和数据库 data URL。只有改成短 URL 并不删除 S3 字节；数据库 data URL 还会复制进 `GenerationJob.sourceImageUrls`。本次未核实生产 managed 开关，不据此声称线上采用哪种路径。 |

上表迁移路径均位于 `prisma/migrations/`。已发布 SQL 必须保持原字节；后续实现使用新增迁移。

## 最小生命周期与 SQL 改动

1. **新增可空 `ImageAsset.expiresAt`，旧行 NULL 保持原策略。** 新临时写入由可信服务端设置非空值，客户端不能选择延长或转成永久。新参考图建议从首次确认可用起算一小时；生成图以整批任务成功完成为交付起点。不要每次查看、重试或重复回执都续期。
2. **生成图先有有限的暂定期限，成功时一次性确定交付期限。** 可在确认写入时先给 `now+1h`，避免“未绑定的输出 NULL 误当永久”；生产任务/预留仍阻止提前删除。然后在 `completeJob` 的同一完成事务中，把该任务新临时输出统一设成 `completedAt+1h`。`worker.go:1089` / `:1274` 已有完成和绑定事务，legacy/v1 两路都要覆盖。不能以第一张图片开始写入或上游发送时作为整批交付时间。
3. **保留历史引用行，修改共享的“是否阻止物理清理”判定。** NULL 资产走现有永久引用规则；非空资产到期后，已结束任务的 JOB_INPUT/历史 URL 只保留来源事实，不永久留住字节。仍保护生产者、实际消费任务、未过期 Canvas PREPARING、读/写/复制租约及未确认对象。展台/封面等持久用途不能被临时清理误伤，应绑定持久副本，不能默默忽略这些根。
4. **消费任务必须用真实绑定核验。** 可复用 `ImageReference` / `ImageUrlAlias` 与 `GenerationJob.sourceImageUrls`、CanvasRun 的规范快照/作业绑定；不需要再造第二套长期引用表。PENDING/PROCESSING 与未解决的 SUBMITTING/SUBMITTED/UNKNOWN 要区分；不能用“已设置 completedAt”推断结果已解决。未知任务的保护不能靠 TTL 自动解除或退款。
5. **接收新输入与清理保持同一锁序。** 提交时在现有引用协调锁及资产锁下确认仍可用、未到期，随后建立任务引用；到期竞争失败返回需要重传。已被接收的任务到期后仍能取得内部读租约。不要在最后入队时只信审核前的 URL 可用性检查。
6. **读接口分清公众读和已接收任务读。** 普通 `image_begin_read` 在到期后拒绝；内部读可增加经过数据库核验的消费任务上下文，并验证该图确实属于该任务、任务仍需它。不能提供用户可传的 `allowExpired`，也不能因为某个任务引用图片就允许所有人继续读取。Worker 的 `generateImages` 在 `generation.go:68` 调 `loadImageSources`，后者在 `image_managed_storage.go:511` 调 `readManagedImage`；沿这条已有链传任务身份即可，继续用现有有界读取和真实字节。
7. **沿现有维护任务增加明确的到期选取方式。** 建议一个 `EXPIRY` 模式，只选非空且已到期的新临时资产，复用 snapshot → claim → delete → finish；不要借 MANUAL_ALL/QUOTA 扫历史资产，也不要另写直接删文件的定时器。共享清理函数、领取阶段和状态触发器必须一致复核。未到期的新临时图片不能被普通容量清理提前清掉；空间不足沿用预留拒绝策略。删除未知/失败不释放计量、不改业务成功状态、不触发退款。

这里“一小时不可访问”与“确认物理删除”是不同事实。不要提前把资产标成 `DELETED`：现有这个状态代表所有计量副本已确认消失。列表/API 要用期限判断不可再读/复用，清理完成后再形成现有 tombstone。可延用已有不可用显示，但准确提示“已过期”，不宣称已物理删除。

## Canvas 与连续图生图

- 若用户的一小时规则包含新 Canvas 导入图及生成结果，必须同步修改这部分新临时资产的永久保存根、CanvasJobAssetUse 和七天保护判断；只改普通图仍会有 Canvas 长期留图。旧 NULL Canvas 资产仍遵守旧约定。Canvas 节点/参数可以保留为过期占位；新运行必须拒绝缺失的原始引用组。不能把“保存场景”继续等同于永久保存临时图片。
- A 图在截止前被 B 任务接收，B 排队跨过截止，B 仍可按原图执行；公众此时不能再下载 A 或给 C 新建引用。B 的输出另有从 B 完成起算的一小时。不能全局刷新 A 的期限，也不能绕过图生图审核或向上游二次发送来补丢图。
- Canvas PREPARING 当前由 `canvas_reserve_run` 的 120 秒期限保护；规范输入核验/提交与清理须协调。COMMITTED 本身不再无限留新临时图片，但对应未结束/不明任务仍受保护。
- 前端当前会过滤不可用引用：`image-source-presentation.ts:29` / `generator-studio.tsx:1059`，一组四张只有一张过期时可能静默变成三张。到期方案必须整组检查；具体界面修复与 Next 图片优化缓存边界见前端研究，不能仅删源文件就宣称所有访问已失效。

## 物理位置、图库与备份

- **新临时图片采用固定独立 key 前缀或独立本地根目录，仍写入现有 managed 账本。** 让未来应用备份、卷归档和对象备份显式排除该范围；旧历史备份不删不改。数据库只保留新临时图片的身份/URL 元数据，不能继续将新 data URL 字节放进任务历史，否则数据库备份仍会永久归档它们。
- 临时位置的所有物理副本都遵守这个边界，包括迁移/复制后的备用对象；仅活动副本在临时目录不够。对象存储版本/未知复制依然依照现有保守清理，不能假装删除成功。
- 图库用户上传是独立的、审核后持久保存的作品；可以复用上传、审核、字节校验和 managed 写入函数。若提供“保存临时图为作品”，须在原图有效且有读/复制保护时读取原始字节，完成审核并写入持久位置，再绑定作品。**只把 `expiresAt` 清空不能完成这个转换**：它仍可能处在备份排除目录，且会改变原来临时交付链接的寿命。
- 不给旧未纳管 S3/data URL 自动补一小时或直接批量删字节。后续只让新生成输出、上传/复用的临时输入进入受管理的短期路径；历史治理若要开展必须另列范围。仅 S3 生命周期或签名 URL 也不足以实现应用侧精确截止与活跃任务保护。

## 需一起修改的契约与复用点

| 层 | 必要范围 |
| --- | --- |
| 新增 DB 迁移 / Prisma | `ImageAsset.expiresAt` 及按期限选取索引；可信写入/完成赋值；新的到期排队方式；条件引用保护、读权限与既有状态 guard；Canvas 新临时分支。不能修改旧迁移。 |
| Node / Go 共享媒体契约 | `contracts/media/v1/{contract,maintenance,schema}.json` 及对应 TS/Go 类型、实际 SQL 函数指纹、迁移链和 readiness revision；Canvas 保留规则改变时同时更新 Canvas storage/retention 契约。`src/lib/storage/image-contract.ts` 为严格解析，SQL 返回新字段后不能只改数据库而漏 Node。 |
| 写入与 Worker | 复用 `prepareManagedImageWrite` / `completeManagedImageWrite`、Go `persistManagedImage`、输出预留/绑定和完成事务。上传/审核持久化仍为同一批字节；有效 count、退款、封禁和上游策略拒绝处理保持原语义。 |
| 读取与删除 | 复用 `image_begin_read`、`readManagedImage`、`image_cleanup_reason`、`image_snapshot_cleanup`、`image_claim_maintenance`、`image_finish_maintenance_object`、Go `imageMaintenanceScheduler.runPass`；不再建第二个下载器/清理器。 |
| 发布与备份 | 新开关/模式须在 Node/Worker 双端兼容验证通过后启用；临时目录/对象前缀有明确备份排除规则；旧数据和旧备份保持。此研究不改变冻结安全发布。 |

## 必须覆盖的回归

1. 真 DB 固定边界：成功完成后 3599 秒仍可读、3600 秒公众读取/新复用拒绝；四张输出统一按整批完成时间起算，重放不续期；新参考图独立计时；旧 NULL 资产原样。
2. A→B 连续图生图：截止前绑定、排队跨期、内部按原字节读取；另一个用户的公开图复用保持现有授权规则，不能用任意 jobId 偷读；截止后新绑定失败；绑定/清理并发不丢已接收引用。
3. 消费任务与生产任务分别覆盖 PENDING/PROCESSING、Canvas PREPARING 和 v1 FAILED+UNKNOWN；不能凭界面失败状态删除或退款。不要为了测试开线上 v1。
4. 已开始的 45 秒读保护、未闭合写预留、复制保护、未知 PUT/DELETE 都延迟物理清理；重试/重复确认只释放一次字节计量，生成费用和成功记录不变。
5. 新临时 Canvas 图可过期且保留节点，旧七天/永久根仍保护；四张参考图只过期一张时整组重试拒绝，不静默减图。
6. 图库新上传持久保存并继续审核；从临时图复制成作品时字节一致、持久位置有备份，原临时 URL 不被续命；所有新临时物理副本和数据库 base64 都不漏进长期备份。
7. 新库和真实既有迁移链的 additive DB 门禁、TS/Go 共同读取/清理用例、schema diff=0、旧 reader/executor 拒绝不支持的新规则。仅单元计时器测试不足以证明锁序和删除账目正确。

本报告是实施边界建议，没有承诺线上已启用一小时清理，也没有执行任何清理或迁移。
