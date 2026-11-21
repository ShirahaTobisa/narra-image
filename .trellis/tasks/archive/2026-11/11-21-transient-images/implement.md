# 实施与验证

1. 完成前期三份研究及本设计复核，固定核心接口/表结构；激活任务后再编辑产品。
2. 存储核心：追加迁移/Prisma/共享媒体与相关Canvascatalogue；Go写入/完成/授权读取/EXPIRY执行/LOCAL临时目录。提供图库审批的原子存储动作。
3. Node存储：同步严格类型、期限读写、已接收输入授权、新媒体路由/别名、可用性与参考图完整组投影；不改变生成数量/补偿。
4. 图库：单图限流有界上传+统一强审、独立记录/幂等、公开/本人/管理员DTO、点赞、审核/撤回、上传UI；沿用作者快照与submittedAt。
5. 主会话：环境/兼容组合/Compose与示例、期限历史UI/终态时钟、Next缓存拒绝、持久图片备份流程、集成协调和冗余清理。
6. 三方向交叉检查；定向单测、Linux文件行为、真实数据库并发/升级/清理/上传权限、全量Vitest/Go/脚本/类型/lint/生产构建；测试用无害图片和模拟上游，不使用真实生图配额。
7. 核对远端与线上ac29727，推送已通过代码，停机排空/备份/配对升级/开启模式/公网验证。回执区分到期拒读、实际删除、所保留历史，归档并同步Git记录。

## 文件分工（避免并发覆盖）

- generation：Prisma、所有新增migration、contracts/media与必要Canvascatalogue、Go worker及其测试；先发布与Node/图库共享的字段/动作契约。
- studio：src/lib/storage及其测试、媒体路由、输入授权与source presentation；协调metadata字段给前端和图库。不开新配置文件的并发编辑。
- auth：图库services/API、公共与管理员作品整合、相关作品前端和测试；Prisma/DDL需求交generation统一落地。
- root：环境/runtime/Compose、Next proxy/image-url、创作历史UI/到期计时与参数重用、备份发布、全局验证与文档。遇到共享文件先消息协调，禁止互相覆盖。

每个代理接任务需以`Active task: .trellis/tasks/11-21-transient-images`开头，读取相关spec和本任务的design/implement；先做最小复用，不另建通用审批/存储/队列框架。
