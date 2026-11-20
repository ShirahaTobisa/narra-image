# Sakura 发布结果

- 代码提交：`1c50f24d33ced985645a01d69f3ade0ebd7562cb`，已推送 `ShirahaTobisa/narra-image:draw-aliya`。作者与提交者均为 `Mornye <121953903+ShirahaTobisa@users.noreply.github.com>`。
- 切换完成：2026-11-21 00:49:26 JST（2026-11-20 15:49:26 UTC）。线上 `DEPLOYED_COMMIT` 与代码提交一致。
- 发布包 124227686 字节，SHA256 `bc12257484497295da98f2e7dd6b621594d9368c02b88f5a91845b10274a2dfa`。完整原始字节基线及新增路径共3342项，prepare与switch前均通过。
- 应用镜像 `narra-image-app:sha-1c50f24d33ced985645a01d69f3ade0ebd7562cb`，ID `sha256:050e113c66f427726eb7e65820cede2ca5bdc73ee30b5c2a14781fa9b9346393`。
- 新应用容器 `c03d7d7d29ece5b65975e98af06a1147d8e6d6e4d6dedea0f798aa9bea5cbf6d`；旧 Worker 容器与镜像固定 b318b6e，数据库容器、图片卷、挂载和端口均保持原样。

## 验证

- 新镜像 Node 24.22.1 Alpine 中，九套定向测试 **183/183** 通过（8.39秒）。测试使用该镜像的实际依赖和Prisma文件、固定stage源码；不是声称对编译后的Next路由执行了账户生图。
- 测试容器无网络、无生产凭据或生产挂载，只读根目录与独立tmpfs，1GiB/2CPU；每次结束核对owner/ID/image/name后精确清理。
- 首次测试8套/123项通过，Canvas套件因隔离目录未引用迁移SQL而未启动。保留 `runtime-tests-first.log`；补 `/tmp/narra-quota-tests/prisma -> /app/prisma` 的只读引用后，同一镜像九套全部通过。没有改产品源码或跳过测试。
- 成功回执绑定同一代码SHA与镜像ID；测试日志SHA256为 `ab27a291e8bae2ea7c4b26f35636a05e3c2b0e37d2a83c2a91b24d9a2c506d25`。
- 回环候选应用真实启动，healthz/readyz正常，迁移状态up-to-date。候选与旧应用运行环境逐项相等，未打印凭据。
- 切换前无PENDING/PROCESSING任务；先停应用入口后再次等待队列清空，再替换应用。已有两个成功任务保持不变，无测试账户或真实生图扣费。
- 上线后本地与公网首页、登录、注册、邀请码页及登录JS均200；未登录历史401、跨站登录写入403、无效登录400。未登录create页的200含Next登录跳转标记，不是放行。
- 应用、Worker、数据库均healthy；上线后应用/Worker日志error/fatal/panic匹配0。审核总开关、敏感词与AI均保持开启，外部API仍关闭。
- 候选容器、两次测试容器与核验过的临时上传已清理；保留回滚镜像和私有备份。

## 备份与证据

私有目录：`/srv/narra-image-backups/20261121-1c50f24`。保留source/env备份、可读取的数据库dump、图片备份、完整构建日志、runtime/candidate/deployment/final-audit回执和发布脚本。stage位于 `/srv/narra-image-releases/1c50f24d33ced985645a01d69f3ade0ebd7562cb`。

回滚只恢复应用源码和原应用镜像，继续复用原Worker/数据库/图片卷。未执行数据库回滚、数据补扣或追溯扣分。
