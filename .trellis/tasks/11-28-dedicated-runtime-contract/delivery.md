# 专用模型配置路径修复

- 线上 H3/Seedream 都曾在调用上游前报 `PROVIDER_NOT_CONFIGURED`。H3 卡密鉴权和基础模板接口正常；实际提交暴露 Worker 配置定位错误。
- 修复仅增加可执行文件旁配置目录优先读取。目录缺失时保留源码开发路径；已存在的打包目录内容缺失或不可读时报错。
- 新回归先在旧实现下失败；修复后复制测试二进制、脱离源码工作目录，成功读取 H3/Seedream 的共享配置，并验证缺少专用模型文件时拒绝回退。
- GenerationContract/Dedicated/Seedream/H3 定向测试、`go vet ./...`、`go build ./...` 及差异格式检查通过。
- 路径修复 `2e20158` 已部署并同步 GitHub，Worker 镜像 `sha256:2b30b0102c8c7fcaf680fb6c27d8dac291dc59c615ac69e109c73ebbf10dbbd0`，备份 `/srv/narra-image-backups/20261128-contract-2e201581/`。随后实际提交发现 H3 的真实任务号是字符串 `js70cdn18yza`，与文档数字示例不同。
- 已修正 Go 提交/轮询/结果和 Node 视频/封面代理的任务号解析。仅接受 1–128 位 ASCII 字母/数字开头、后续可包含 `_`/`-` 的字符串，兼容正 int64 JSON 数字；保留原任务一致性、主机、凭据、路径和重定向保护。
- 再次验证：Go GenerationContract/Dedicated/Seedream/H3 定向测试、vet/build 通过；两个 H3 Vitest 文件 75 项通过，TypeScript 与受影响 TS 的 ESLint 通过。
- 本站测试任务 `2cc43a75-bf43-46b8-9149-1dcd5d76b67c` 对应上游 `js70cdn18yza`，已通过 by-request 核对提示词、尺寸、时长和请求标识。修复期间暂停 H3 新提交，升级后沿用同一任务和幂等标识恢复，不新建付费任务。
- 任务号修复 `9b4aef6` 已部署：应用 `sha256:15f02de7edd06ab75e72acc901cddc3e75c7b023bd74c334d74f6358d7ed8d20`、Worker `sha256:c29586ae224c9481cbc61842ef71f1c93423e93d7a20154555eb6dcef56067df`，备份 `/srv/narra-image-backups/20261128-h3-id-9b4aef69/`。候选及线上 readyz 通过，数据库容器、运行参数和挂载不变。
- 原测试任务已接回，19:34 JST 起处于 PROCESSING，沿用同一上游任务且没有再扣上游次数。19:42 JST 查询上游仍为 `pending` / 排队中，`started_at` 为空。
- 实测还发现 H3 排队超过默认 15 分钟，文档明确客户端允许等待 90 分钟。因此只延长 H3 任务截止，保留心跳、取消和图片原截止；删除视频界面按时间虚构的百分比与倒计时。
- 本轮 Go 定向测试、vet/build 通过；前端类型、受影响文件 lint 和等待界面测试通过。
- 等待修复 `f682c36` 已推送并于 19:49 JST 部署：应用 `sha256:e4c56af731733c3fbad90228ac3c1e57624d82d5bfadecf9af54deae3a030eac`、Worker `sha256:0f880dbaa1e85489a0ee2e0eaaf79cd68c2de1fa5e7451cc3d9cb7dbc7d003af`，备份 `/srv/narra-image-backups/20261128-h3-wait-f682c363/`。完整生产构建、候选就绪与线上就绪均通过；未迁移数据库，运行参数和挂载不变。
- 构建期间用户提交任务 `d79db418-0273-43c4-ab7b-c750fa3c2cc2`，对应上游 `j33acrxfba6t`。升级前对两单逐一核对 by-request、提示词、尺寸、时长，升级后用同一任务 ID 和幂等标识接回。两单各保留一次 20 积分和原每日名额，上游没有新建重复订单。H3 已恢复启用。
- 19:51 JST 核对：两单均为本站 PROCESSING、心跳正常、无错误；上游均为 pending / 排队中、无成片。浏览器已验证新版等待提示，已移除虚构百分比/倒计时。
- 尚未完成：实际成片、本站播放和下载验证。原因是上游尚未开始出片；服务器继续轮询现有订单，不再次提交付费测试。任务保留 in_progress，不归档为完成。

## Seedream 可用性核对

- 用户追加询问后，发现线上 Seedream 只有修复前的失败记录，且两个 H3 占满 `WORKER_CONCURRENCY=2`。在现有并发中预留第一个位置只领取图片，其余仍通用领取；不增加总并发，保留每用户上限和 FIFO。
- 为腾出本轮测试账号，核对并取消仍为 pending 的自建 H3 测试单 `js70cdn18yza`，上游返回 cancelled，本站自动退款。真实用户任务 `j33acrxfba6t` 未取消。
- 20:00 JST，网页使用 UID 1 提交 Seedream 测试 `ac2f038f-1160-4b84-bad0-cfb59092d067`，耗时 16.5 秒成功出图：`c84c396b83e94225aac21ed21`，1024×1024、LOCAL，扣 5 积分、占一次每日名额。
- 浏览器验证图片完整加载（naturalWidth/naturalHeight 1024×1024），点击下载成功保存 `C:/Users/aphrissa/Downloads/11-28-20-01.png`。
- Go 定向测试、vet/build、TypeScript 和差异检查通过。新增真实数据库回归覆盖文生图/图生图在多个视频排队时仍可领取；原 TypeScript 6 项与 Go 数据库契约全通过。首次测试因 Docker 未启动及桌面内置 pnpm 版本不匹配退出，启动本机已安装 Docker、固定已缓存 pnpm 10.32.1 后完成原检查，无生产测试库或依赖重装。
