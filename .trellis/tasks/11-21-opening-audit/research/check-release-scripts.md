# 发布脚本独立静态审查

2026-11-21 最终复核：本轮阻断项均已关闭，受审字节未发现新的发布阻断问题。结论仅覆盖静态代码及语法，不代替实际隔离 DB、运行时测试、迁移和候选回执。没有执行脚本主体、Docker、SSH、迁移或发布。

范围：`D:/tools/codex/tmp/narra-opening-package.cjs`、`narra-opening-baseline.py`、`narra-opening-release.py`、`narra-opening-runtime-check.py`、`narra-opening-db.py`。另只读核对仓库 disposable Worker DB runner、隔离环境/Prisma config、Docker 安全 helper、Dockerfile/Compose 和 rollback snapshot 契约。

## 原问题关闭情况

1. **并行发布互斥**：release.py:324–328 使用服务级 `fcntl.LOCK_EX | LOCK_NB`；阶段所需基线、容器和回执在锁内复核，两个 switch 不能交错替换/恢复。
2. **测试对象与启动对象一致**：:75–83 消费 DB/runtime 的 SHA、app ID，以及 DB 的 worker/builder ID，并校验 stage 原始文件摘要。migrate/check 使用精确 ID；:219–249 将精确 ID 写入 `.env`，正式 up 显式传递对应 `revision_env`。标签变化不能先启动未测试镜像后才发现。
3. **精确旧版本恢复**：:299–304 用原 app/worker Image ID 启动，核对健康、镜像、挂载和完整环境；不只依赖旧标签。保留新增 nullable 列，不恢复数据库或图片卷。
4. **迁移连接及外层环境**：:18–20,37–38 默认环境仅 PATH/HOME/LANG；:143–148 迁移前比较 effective Compose migrate DSN 与精确旧 app DSN，只比较不输出凭据。复核发现正式 up 一度漏传隔离环境，最终 :249 已补齐；stop/config 等默认调用也使用白名单。
5. **存储契约路径**：package 已改为实际的 `contracts/media`，保留 runtime/Canvas、Dockerfile/Compose 和依赖输入约束。
6. **验收 Docker endpoint**：复核发现 runtime-check 的裸 docker run/rm 与 release.inspect 连接不一致，最终 :61,75 都已固定 `unix:///var/run/docker.sock`。

## 发布与恢复边界

- baseline archive 固定 SHA-256；baseline.py 保存逐文件原始字节摘要，拒绝非普通文件、绝对路径和 `..`。package 核对 baseline Git blob/部署 archive 内容，为新 archive 生成完整 sourceFiles。release 核对原部署源码、三个精确旧容器及 stage 源码；没有错误要求独立历史旧 Worker 的 label 等于 app 基线 SHA。
- 仅允许固定 checksum 的 `20261121000000_public_author_name` 新 migration。构建 app、worker、worker-builder；DB/runtime 回执先完成，再迁移、候选检查，最后停 app、重新排空、停 worker，依次替换 worker/app。
- 替换源码时 :232–238 仅删除原 manifest 中有原始摘要、但新 Git archive 不再包含的文件；删除前核对路径位于 ROOT、非 symlink、原摘要一致，解包后验证完整新 sourceFiles。不是按目录/前缀清理，也不会删除未知上传文件。
- 替换前失败恢复精确旧容器；替换后失败先关闭入口、排空，再保存只读 rollback snapshot。:274–280 要求 snapshot schema 1、image/Canvas revision 都为 3，任务、handoff、预留、对象、历史、观察等八项未决计数为零；失败则入口保持停止、当前 Worker 保留，不清任务或恢复旧数据。
- 恢复只针对本次核实的旧 b318 Worker 与新 Worker 的同 revision-3 能力、不变契约。旧 legacy Safe() 返回 false 不能泛化为允许任意降级，也不授权回到缺少 managed-storage 读保护的版本。
- 迁移容器仍运行时保留检查；候选按保存的精确 ID 清理。没有 down --volumes、prune、恢复 database.dump 或删除图片卷。

## 隔离 DB harness

- db.py:207–274 只用 Linux 本地 socket、现有静态 Docker CLI 和 inspect 得到的精确镜像 ID；create 都为 `--pull=never`，release 模式核对 app/worker/builder revision。成功回执在测试及清理成功后独占创建，记录全部镜像 ID。
- 仅复制列举的源码/依赖输入，拒绝 symlink，排除 dotenv/npm 凭据/node_modules，复制前复核摘要。固定 runner 的 seed/check/diff、离线 Go、直接 Vitest 和父端 PG 回执补丁只作用于 scratch，不改生产源码。
- 测试容器没有生产 datasource/env/数据卷注入；执行使用 env -i、deny-env preload 和合成环境。它为一次性 PG 使用 host network 和本机 Docker socket，因此不是不受信任代码沙箱；结论建立在本次审阅的固定 runner/helper 上。
- 已追到真正连接点：postgres-runner.ts:445–502,638–663 创建随机名称/口令、localhost 动态端口、tmpfs 的 PG，DSN 只来自这个已验证容器。disposable-test-environment.mjs 校验用户名/随机库名/127.0.0.1/端口/查询参数，覆盖 DATABASE_URL/TEST_DATABASE_URL，创建不加载项目 .env 的独立 Prisma config。AUTHOR_CHECK 再次验证相同 DSN，没有回退开发/线上库分支。
- 依赖来自精确 app 镜像 node_modules 和精确 builder 工具链/module/cache；package/lock/workspace 必须一致。Go 为 GOTOOLCHAIN=local、GOPROXY=off、GOSUMDB=off、-mod=readonly；Vitest 直接运行 installed 入口，无 Corepack/pnpm 自动下载。缺镜像/缓存会失败，不 install/pull。Prisma 使用现有 CLI 与相同 Alpine 环境。
- 内层 LocalDockerSession 验证 local endpoint 后固定 --host 和空 auth config；外层也固定 socket、空 config、最小环境。外层先停精确测试容器，再读 PG receipt，核对精确 ID/名字/owner 删除；无回执但同名资源存在则保留并失败，不按前缀猜测删除。清理失败不生成成功回执；scratch 校验父目录/前缀/非 symlink/owner；内外不删 volumes/images。
- DB 断言包含迁移前旧图片/视频行，迁移后旧行 null，新 writer 省略字段为 null，显式署名往返，Prisma diff0，以及原 TypeScript/Go Worker DB suites。

## 最终受审字节与验证

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| narra-opening-package.cjs | 3691 | `09d17be1447a9ccc827f476b0a4a0acfa8598aade3d37ed733e2669a5e0a3a9e` |
| narra-opening-baseline.py | 949 | `a25d092192347387be22affa2d22038c558feae65207461598020b67e97d74c8` |
| narra-opening-release.py | 22409 | `04e1550fa604467eba8021864b0974eb665f1d8d79f7f3cb295a876cf82d9fc1` |
| narra-opening-runtime-check.py | 4972 | `30397695d33ff3e5e9e0861c81fdbadba4ebc277032231e5830d6176c21f3593` |
| narra-opening-db.py | 23799 | `2d1f6cf1069aa45875962461bbea437f5bd717299c721b26038dbe3d8564d607` |
| narra-opening-http.py | 3938 | `ba8b8b48d2db162dc88965c90d1a7917d0338277303eef5f452d1b0bdd120225` |

node --check 验证 package；Python ast.parse 验证四份 Python 脚本，全部通过。只解析，没有 import/run 主体，没有访问生产服务。能否实际发布仍以受审脚本执行的 DB/runtime、迁移、候选和切换回执为准。

## 追加复核：Windows tar 的方括号路径

2026-11-21 02:04：主代理实跑发现 Windows tar 把 `[id]` 路径当成 pattern。现 baseline.py 的 `--details` 一次按 tar 成员字面名称读取固定基线 archive，返回 raw hashes 与仅 CRLF→LF 的 normalizedHashes；package 用后者对照 Git blob，不再逐文件执行 tar。release 消费的 baseFiles 仍是原始字节摘要，不能拿规范化摘要检查线上文件。新 archive 的普通参数模式仍只返回 raw sourceFiles；原 archive 固定摘要、成员类型及路径 guard 保留。两个 helper 再次完成静态检查、ast.parse/node --check，通过；上表已更新为新字节。没有重跑打包或改动 release 主脚本。

## 追加复核：Discord-only HTTP smoke

2026-11-21 02:12：按已定稿 auth 路由/页面检查新的 narra-opening-http.py，未发现契约不符。公开 `/login` 服务端含 Discord 链接、无 auth-email；`/login?admin=1` 保留原表单；register/invite-claim/create 的未登录分支跳转 `/login`。helper 同时接受 HTTP redirect 和 Next 流式 meta redirect，校验登录脚本可读；禁用 LinuxDo 两端与邮箱注册/领码返回 403，未登录历史为 401，login 空体同源为 400、跨域为 proxy 的 403。

helper 不携带 cookie/账号密码，不请求实际 Discord authorize/callback，不尝试生图；唯一 POST 为无字段的登录/已关闭注册/已关闭领码校验，不能创建账号或消耗生成。静态审查及 ast.parse 通过，没有执行 smoke 或任何真实请求。release.py:136/319 已同时切换为远端 `/tmp/narra-opening-http.py`；上表更新相应 release 摘要。主代理明确初批 57b5cf5 仅 prepare，最终新 SHA 会重新上传全部 helpers，不能继续用旧远端 copy 的回执。

## 最后增量：固定 PostgreSQL 镜像与政策测试

只读核对新字节：db.py:336 在 release-helper 模式直接使用同一 manifest 的 `containers[2].image` 精确 PostgreSQL ID；release.py:82 要求 DB 回执的 postgresImageId 与该 ID 相同，避免验收使用浮动 postgres:17-alpine。这里只复用经过核实的镜像，仍启动随机 localhost/tmpfs 实例，不使用线上容器或数据卷。

runtime-check 清单由 16 套增为 24 套，新增 moderation-check、public-auth-policy、public-login-page、discord-oauth、admin-user-ban-route、public-work-visibility、featured-route、work-like-route；执行/隔离/精确 owner 清理方式未变。release、DB、runtime 三份新 SHA-256 与主代理给定摘要逐项一致，HTTP 摘要未变；四份 Python ast.parse 通过。上表已更新。此增量未运行产品测试或 harness 主体。

## 实机测试环境调整

首次隔离 DB 检查在创建任何容器前停止：服务器 `/usr/bin/docker` 动态依赖 glibc，原脚本只接受静态客户端。仅调整临时 harness：动态分支限定系统 Docker、x86_64 加载器和 libc，解析真实路径、所有者、写权限、ELF 与实际依赖；两个固定库文件只读挂载，挂载前后重核字节。没有安装软件、放开生产数据或修改产品镜像。原失败日志保留为 `db-tests.log`，后续执行使用 `db-tests-final.log`。

DB helper 新 SHA256 为 `dea9eb4e6f7595991292134c293a21efc342ead6e10675cc496e8f946b8cb129`；实施代理完成语法、15项解析正反例和计划模式，主代理复核实际分支与挂载范围。成功回执另存 `dockerCliRuntime.files` 的客户端/运行库原始路径、目标路径和摘要。最终部署核查脚本也在读取 manifest 前取得同一个发布锁，持锁至回执和精确临时文件清理结束，避免并行发布交错。
