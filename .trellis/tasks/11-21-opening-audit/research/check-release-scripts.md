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
| narra-opening-package.cjs | 3819 | `765f145e7a7fd325752acc0b6bd50d25ef6e60e76cf94efc4d97caa5e87d6a09` |
| narra-opening-baseline.py | 688 | `00f930ce50ea09f66ae57138648a27e1a3726c10399372728241c0f18ee2af1b` |
| narra-opening-release.py | 22345 | `4cd1d521a2fdd44f6de9430fcf403d4e50b94cbc4aff34c8ca145482eb34349a` |
| narra-opening-runtime-check.py | 4588 | `2eb0ad69f6b827e54d46832236539154aa7073fb3013465f958857ac2c5a3a2f` |
| narra-opening-db.py | 23730 | `d38c4a92e9f36cd11a7cd6702f0b1bb73221a425ac658914f6f372055e378b69` |

node --check 验证 package；Python ast.parse 验证四份 Python 脚本，全部通过。只解析，没有 import/run 主体，没有访问生产服务。能否实际发布仍以受审脚本执行的 DB/runtime、迁移、候选和切换回执为准。
