# Discord-only 独立交叉审查

2026-11-21 最终结论：本轮发现的设置页兼容缺口已修复并复核，当前未发现未关闭的阻断项。只读产品代码，没有提交、部署、真实 OAuth 授权或账号操作。

## 范围与确认的边界

审阅 access-policy、oauth-config、Discord helper/callback、login/register/LinuxDo/领码/Discord unlink 路由、login/register/invite-claim/settings 页面、DiscordLogin/ProfileForm 及关联测试；追读现有 oauth-accounts、LinuxDo unlink、session/current-user 调用边界和 proxy。

- 按主代理明确授权，本次限制新的公开登录/注册，不撤销旧有效 session/API Key。旧邮箱/LinuxDo 会话继续生成和在设置绑定 Discord 属于既定范围，不是新准入绕过；退出且未绑定的普通旧账号须管理员协助，不自动按邮箱合并或转移积分。
- `/login?admin=1` 仅选择展示原邮箱表单，不授予权限。login route:47–57 先验证密码，再从数据库真实角色判断 ADMIN；普通用户提交 role/admin 字段无效。普通错密码、管理员错密码、未知邮箱保持原 401/失败计数，原验证码、锁定和封禁检查保留。
- register、领码、LinuxDo authorize/callback 直接 403，不解析 body、占邀请码、建号、交换令牌或签发会话。没有其他新增公开账号创建/会话签发旁路；保留后台历史配置不会重新打开这些入口。
- Discord authorize/callback 都拒绝未配置群限制；callback 保留 state 比较和清理，必须完成成员验证后才绑定/找号/建号。普通非成员、pending、接口失败不能获得会话；旧邀请码 cookie 不参与准入。现有绑定按 provider + Discord immutable ID 找回原 User，既有会话绑定更新当前 User，不重新赠送积分。
- Discord unlink 在服务器先读取当前用户角色，普通账号不能靠直接 POST 或客户端资格参数移除唯一登录方式；管理员仍须通过现有 passwordHash 检查。LinuxDo unlink 只接受对应 provider，不能用它删除 Discord 绑定。
- 公共页面不读取 Turnstile 配置、不挂邮箱表单；恢复页保留原 AuthForm 验证和请求状态处理。未配置 Discord 时显示不可用，不回退公开邮箱注册。

## 本轮发现及修复验证

最初 ProfileForm 对所有 linkedLabel 都走已绑定区，新的 canUnlinkOAuth 又使普通用户无解绑入口，导致旧 LinuxDo 有效会话无法从设置绑定 Discord，且提示错误地说不能解绑 Discord。已由 auth 作者最小修复：仅已有 Discord 走保留/解绑区，其他旧 provider 显示 Discord 绑定链接及替换旧绑定、保留数据的说明；沿用现有受鉴权 callback，不新建迁移接口。

同时收口 ProfileForm 中“昵称直接公开”“邮箱为登录凭证”的旧文案，改为投稿默认匿名/保存当时署名，以及普通账号 Discord 登录、管理员密码恢复。已检查最终 diff，补丁未扩大服务器绑定能力。

## 实际验证

全部使用 disposableTestEnvironment 的合成环境及 deny-env preload，数据库/Discord/验证码均为测试 mock，不是线上验收。

- 第一轮独立运行 public-auth-policy、public-login-page、register-route-bootstrap、discord-oauth、auth-form、auth-form-submission、linuxdo-oauth：7 套 63/63 通过，7.91 秒。
- 设置页修复后，独立运行 profile-form-auth-policy、discord-oauth、public-auth-policy、public-login-page：4 套 36/36 通过，4.10 秒。新增覆盖旧邮箱/LinuxDo 会话均可绑定 Discord、普通 Discord 用户保留绑定、管理员恢复资格和对应文案；callback 原有绑定用例扩为两种旧来源。
- 主代理统一执行最终全量检查。新的 HTTP-only helper 已按实际路由/页面契约静态核对，摘要及不访问真实 OAuth/生成的范围见 check-release-scripts.md。
