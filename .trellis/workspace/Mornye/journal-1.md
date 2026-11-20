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
