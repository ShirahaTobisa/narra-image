# 记录全站账号 IP 并查询同 IP 账号

## Goal

记录所有账号后续登录和访问 IP，后台汇总跨账号共用 IP；保留现有登录与审核行为。

## Requirements

- 所有账号成功登录、有效会话访问和 API Key 访问均记录可信 IP，包括旧账号后续访问。
- 管理员可全站查询同 IP 的多个账号、全部 IP、UID/昵称/Discord ID 及首次/最近出现时间，支持 IP 搜索与分页。
- 只存账号、IP、时间；不记录 Cookie、密钥或请求内容，不自动封号，写入故障不阻断请求。

## Acceptance Criteria

- [ ] 可信代理来源、规范化、节流和鉴权后记录通过测试。
- [ ] 仅管理员查询，真实隔离 PostgreSQL 验证新增迁移和聚合。
- [ ] 推送部署后验证记录和全站汇总；没有上线前历史时明确展示空状态。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
