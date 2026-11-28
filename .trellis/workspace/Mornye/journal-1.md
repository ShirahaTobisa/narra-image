# Journal - Mornye (Part 1)

> AI development session journal
> Started: 2026-11-20

---

## Session 1: 登录验证与生图稳定性

- 日期：2026-11-20
- 分支：`fix/site-stability`，基线 `2087e89`；尚未提交。
- 完成登录/签到/领码错误恢复、Turnstile 重试、封面查询、图片复用与审核、重试参数、参考图顺序及取消任务统计修复。
- 共享三个小模块，升级存在已知漏洞的依赖；独立审阅发现的问题已补齐。
- 验证：2,343 项 Vitest、47 项脚本测试、Linux Go、类型、lint 和生产构建通过；依赖审计为 0。
- 真实数据库集成、线上账号/验证码/计费出图未执行。未推送或部署。
- 任务与详细记录：[generation-stability](../../tasks/archive/2026-11/11-20-generation-stability/verification.md)。


## Session 2: 发布登录验证与生图修复

**Date**: 2026-11-20
**Task**: 发布登录验证与生图修复
**Branch**: `fix/site-stability`

### Summary

已将修复推送 draw-aliya，并部署到 sakura；备份、候选启动、迁移状态、公网页面及访问限制检查通过。

### Main Changes

- APP_IMAGE 固定至 aeee856；数据库、Worker 和图片卷保持原实例。

### Git Commits

| Hash | Message |
|------|---------|
| `aeee856` | (see git log) |

### Testing

- [OK] 本地 2343 项 Vitest、47 项脚本、Go、类型、lint、生产构建通过；线上 HTTP 验收通过。

### Status

[OK] **Completed**

### Next Steps

- 真实账号登录、第三方验证码和计费出图尚未执行。


## Session 3: 审核补漏与安全发布

**Date**: 2026-11-20
**Task**: 审核补漏与安全发布
**Branch**: `fix/site-stability`

### Summary

强制站内完整AI审核，覆盖负面提示词/静态参考图、完整分类和输入覆盖，保守NSFW阈值；修正公网图片下载、首次配置、外部编辑数量限制和Worker安全拒绝。2426项Vitest、47项脚本、Linux Go、类型/lint/构建及依赖审计通过。已推送draw-aliya并在sakura更新App+Worker；备份、健康、无害图文审核与访问限制验收通过，未进行真实生图。

### Git Commits

| Hash | Message |
|------|---------|
| `b318b6e` | (see git log) |

### Status

[OK] **Completed**


## Session 4: Preserve img2img with independent local image prescreen

**Date**: 2026-11-20
**Task**: Preserve img2img with independent local image prescreen
**Branch**: `fix/site-stability`

### Summary

Kept reference-image generation; added fixed local NSFWJS/WASM prescreen before remote moderation with bounded queue and fail-closed handling. 2464 app tests and 54 script tests pass; verified exact Node24 Alpine image offline on Sakura, deployed app, preserved worker/database and recorded limitations. Dedicated CSAM service remains unavailable with current credentials.

### Git Commits

| Hash | Message |
|------|---------|
| `ff5dfec` | (see git log) |

### Status

[OK] **Completed**


## Session 5: 修复多图扣费与每分钟五张限额并上线

**Date**: 2026-11-21
**Task**: 修复多图扣费与每分钟五张限额并上线
**Branch**: `fix/site-stability`

### Summary

按实际输出张数计费并共享每用户五张/60秒额度；修正Kelivo与SSE超限HTTP429。2514项测试、54项脚本测试、tsc/lint/build及Alpine镜像183项定向回归通过。已推送代码并部署Sakura，审核保持开启，Worker/数据库/图片卷未变，健康和上线日志检查通过。

### Git Commits

| Hash | Message |
|------|---------|
| `1c50f24` | (see git log) |
| `4801a8a` | (see git log) |

### Status

[OK] **Completed**


## Session 6: 开站安全复核与部署

**Date**: 2026-11-21
**Task**: 开站安全复核与部署
**Branch**: `fix/site-stability`

### Summary

完成17项报告核对，修复公开作者隐私、封禁任务与公开资格、入队占位、头像审核、模型输入；按用户确认上线Discord-only及滚动24小时合计3次违规暂停。目标镜像、完整及部分基线数据库验证通过，ac29727已部署Sakura并推送draw-aliya。用户新增1小时临时图与上传广场要求转入后续存储任务，研究已保留。

### Git Commits

| Hash | Message |
|------|---------|
| `57b5cf5` | (see git log) |
| `c9ab556` | (see git log) |
| `6d80fa6` | (see git log) |
| `ac29727` | (see git log) |

### Status

[OK] **Completed**


## Session 7: 下载图片改为时间戳命名

**Date**: 2026-11-25
**Task**: 下载图片改为时间戳命名
**Branch**: `fix/site-stability`

### Summary

统一作品页、创作台和后台图片下载为毫秒时间戳文件名；保留真实格式后缀，删除旧前缀参数，代理下载避开旧文件名缓存。38项相关测试、lint、类型检查及生产构建通过；已推送 draw-aliya 并部署 sakura，健康检查与首页、登录页正常。

### Git Commits

| Hash | Message |
|------|---------|
| `fcbd17a910c1ae1bd2808924c55fedb53232da3b` | (see git log) |

### Status

[OK] **Completed**


## Session 8: 下载时间戳调整为秒

**Date**: 2026-11-25
**Task**: 下载时间戳调整为秒
**Branch**: `fix/site-stability`

### Summary

按用户要求将下载名和代理下载参数从毫秒改为秒级时间戳，例如1795593600.webp。38项相关测试、lint、类型检查和生产构建通过。已推送 draw-aliya 并部署 sakura，线上健康及首页、登录页检查通过。

### Git Commits

| Hash | Message |
|------|---------|
| `410ce980f4c5818aa0d375a36fa34113b110786e` | (see git log) |

### Status

[OK] **Completed**


## Session 9: 图片下载使用可读时间

**Date**: 2026-11-25
**Task**: 图片下载使用可读时间
**Branch**: `fix/site-stability`

### Summary

按用户要求统一图片下载名为本地时间 mm-dd-hh-mm，24小时制、补齐两位；复用时间函数，代理只接收受限时间格式以保持下载者时区一致，保留真实格式后缀。40项相关测试、lint、类型检查和生产构建通过，已推送并部署 sakura，线上健康与首页、登录页检查通过。

### Git Commits

| Hash | Message |
|------|---------|
| `48fd6e91f697bd2756a02be1a0a059b6aee77377` | (see git log) |

### Status

[OK] **Completed**


## Session 10: 全站账号 IP 记录与同 IP 查询上线

**Date**: 2026-11-27
**Task**: 全站账号 IP 记录与同 IP 查询上线
**Branch**: `fix/site-stability`

### Summary

全站登录、会话与 API Key 访问记录可信 IP；管理员可查共享 IP、全部 IP、账号身份与时间。51 项测试及真实 PostgreSQL 检查通过，已部署并确认真实访问写入。历史未保存的 IP 无法补查。

### Git Commits

| Hash | Message |
|------|---------|
| `7d27a18597f9d606b00692ccf5cf6537e44d28f3` | (see git log) |

### Status

[OK] **Completed**


## Session 11: H3 credential setup and activation

**Date**: 2026-11-28
**Task**: H3 credential setup and activation
**Branch**: `fix/site-stability`

### Summary

Configured the existing H3 card through the logged-in browser and charity-site admin UI. Authenticated read-only API checks passed. Enabled the H3 channel and VIDEO_ENABLED on app and worker with backup and unchanged images. Browser verified model h3, single reference upload, global 10/day and account 1/day. No paid generation was submitted.

### Git Commits

| Hash | Message |
|------|---------|
| `a7e1c40` | (see git log) |
| `34eb6c6` | (see git log) |

### Status

[OK] **Completed**


## Session 12: H3 运行配置、任务号和排队等待修复

**Date**: 2026-11-28
**Task**: H3 运行配置、任务号和排队等待修复
**Branch**: `fix/site-stability`

### Summary

三处修复已推送部署，保留上游原单接回两条任务；相关测试构建和线上就绪通过，等待界面已验证。H3 上游仍排队，实际成片与播放下载待验证，任务保持进行中。

### Git Commits

| Hash | Message |
|------|---------|
| `2e20158` | (see git log) |
| `9b4aef6` | (see git log) |
| `f682c36` | (see git log) |

### Status

[OK] **Completed**


## Session 13: Seedream 实测通过并预留图片处理位置

**Date**: 2026-11-28
**Task**: Seedream 实测通过并预留图片处理位置
**Branch**: `fix/site-stability`

### Summary

Seedream 网页实测 17 秒生成 1024×1024 图片，加载和时间戳下载正常。修复 H3 占满处理位置，真实数据库回归通过并已部署；用户 H3 原单接回，视频实际出片仍待上游。

### Git Commits

| Hash | Message |
|------|---------|
| `79912a9` | (see git log) |

### Status

[OK] **Completed**
