# Sakura发布记录

2026-11-20 21:07 JST完成切换，原生图入口与参考图能力保留。

- 代码：`ff5dfec7bfad6d153078dcb7d3b04580247f1171`，已推送 `ShirahaTobisa/narra-image:draw-aliya`。
- app镜像：`narra-image-app:sha-ff5dfec7bfad6d153078dcb7d3b04580247f1171`。
- app image ID：`sha256:1efef489d1df04c126175f9e364ace97c01371d96ab9531c628de9a51730021d`。
- app容器：`23b77b33cce6b0fae6416abd7a06597581cbe5c2b599ae5712b4331a0010c3d9`。
- 旧Go Worker容器 `a564c44a8477f12c428ca00a1746d10df3820139cbed23256e426f9cdbb69df6` 和数据库容器 `54a74cdcd4e6fa5121645b14e8f66cefcd2890a182d8b60b32058aea8beb9253` 未重启，全部健康。图片/数据库卷保留。

## 实际目标镜像验证

使用精确image ID，在无网络、无生产挂载、无凭据、只读文件系统、1CPU的独立容器运行；成功/失败/超时都按唯一owner/name/ID清理。Node v24.22.1/Linux x64实际通过，弥补上游NSFWJS仅声明Node22.13.0的兼容性空白。

- `scripts/tests/moderation-image-worker.test.mjs`：7/7通过，512MiB容器，约2.66秒。含真实模型、本地权重加载、无害正例低于业务阈值、完整分数、损坏图、透明RGB、EXIF、像素上限及原字节保留。
- 512MiB基准：冷加载605ms，16张普通图1230ms，热P50约78ms，普通峰值243MiB；单张64MP透明图344ms，整体峰值437MiB。
- 768MiB压力基准：冷加载645ms，16张普通图1213ms，再连续16张64MP透明图5629ms，峰值638MiB。业务仍限制整请求8秒，等待也算入；此离线压力程序用于测量，不替代父端超时门禁。

上述RSS是隔离Node进程的采样值，不是整个网站的内存上限，也不证明任意输入都在此范围。没有NSFW/CSAM样本；这些正例与模拟拒绝测试不能得出漏检率或“绝不会封号”。现有专用CSAM接口凭据测试返回404/model_not_found，本次没有申请账号或启用该接口；普通omni仍为本机检查后的第二层。

## 发布保护与线上复查

- 完整核对上一版本部署包的3269个文件原字节，并纳入本次新增文件，总3315个路径；prepare与switch前重核。部署包SHA-256：`bc6eb5498e74eb677f5e7d9826c47e76f761b9a10c76024523ef46719fb582f3`。
- 只构建/切换app。构建变体仅限制 `CIRCLE_NODE_TOTAL=3 NODE_OPTIONS=--max-old-space-size=1536`，代码、运行环境和Dockerfile其他行为不改。
- 新候选容器只绑定127.0.0.1:13001，环境完整逐项等同旧app，镜像/挂载/迁移状态核对通过。模型回执严格绑定提交和实际image ID。
- 切换前空队列，停入口后再核对，保持Worker处理既有任务。`DEPLOYED_COMMIT`已更新；DB迁移为up-to-date，无新schema或迁移。
- 内网healthz/readyz均200/READY。公网首页、登录、注册、邀请页200，登录脚本可加载；未登录创作页含流式登录跳转，历史401，跨来源登录写403，无效登录400 JSON。
- 有效审核总开关、词库和AI仍启用，远程仍为官方omni，外部API仍关闭；成功任务仍为原有2项，无待处理任务。没有为了验收发起收费生图或修改用户数据。
- app/Worker完整日志均无error/fatal/panic匹配；临时候选容器、3个模型测试容器和本次/tmp上传文件已核对清理。

## 留存与回退

服务器私有备份：`/srv/narra-image-backups/20261120-ff5dfec`；源码stage：`/srv/narra-image-releases/ff5dfec7bfad6d153078dcb7d3b04580247f1171`。备份含源码/.env、已验证可列目录的DB dump、图片tar、完整构建/模型/应用日志、旧容器身份、候选/部署/最终检查JSON及审阅过的发布脚本。

旧app回退标签：`narra-image-app:rollback-b318b6e-ff5dfec`，旧app image ID为`sha256:211927ca1fa5edf6c247322a27c8cb0b707eb08a1feb07e764e17c5e351992c2`。脚本回退只恢复源码和app镜像pin；不restore实时数据库、不删除或覆盖卷、不重启现有Worker。自动回退路径已审阅，本次正常发布未触发实际回退。
