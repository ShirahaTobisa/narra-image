# Discord 公开登录策略实施

## 已确认的范围

用户本轮明确选择关闭公开邮箱注册、仅使用 Discord；主代理只读生产证据为：OAuthProvider 仅有 Discord、已开启、有群限制和凭据；存在未封禁且有密码的 ADMIN。没有读取身份、密码或凭据内容。本子代理未访问生产，没有提交或部署。

这次限制新的公开登录/注册，不撤销已签发的正常会话、不删除账号或积分、不新增号龄/入群时长规则。管理员邮箱密码是明确保留的恢复方式。

## 最小实现

- 新 `src/lib/auth/access-policy.ts` 集中 Discord-only 文案、管理员密码资格与现有群 ID 解析；不增加环境变量或权限框架。
- `/login` 仅服务端渲染 Discord 入口，不读取 Turnstile 配置；`/login?admin=1` 才加载原邮箱表单与原验证码配置。`/register`、`/invite-claim` 重定向 `/login`，不再查询邀请库存或显示注册表单。
- `POST /api/auth/register`、`POST /api/invites/batches/[id]/claim` 固定返回清晰的 403，发生在解析、验证码、邀请码占用、密码哈希和建号之前。初始管理员邀请码配置也不能重新打开这个入口。
- LinuxDo 授权与回调固定 403；即使日后管理员启用其数据库配置，直接请求旧路由也不会取令牌、建号或发会话。后台原配置/邀请码管理及历史数据保留；它们不能越过公开接口限制。
- 邮箱登录仍先执行原限频、人机验证、账号封禁和密码验证；只有密码正确且数据库实际角色为 ADMIN 时签发会话。普通用户的错误密码与未知邮箱均保持原 401、原提示和失败计数，不能通过提交 `role/admin` 字段获得权限。
- Discord authorize/callback 都必须有非空解析后的群列表，否则拒绝；授权固定申请成员读取。群成员资格仍在每次登录/绑定时检查，非成员、pending、远端错误不放行，旧邀请码 cookie 只清理、不再参与准入。
- 公开/设置页登录源查询只取 Discord，并过滤未配置群限制的记录。管理员配置查询不变。
- 普通用户即使设置过密码，也不能再解绑唯一可用的 Discord；服务器检查角色，UI 使用 `canUnlinkOAuth`。有密码 ADMIN 仍可解绑，无密码 ADMIN 沿用原拒绝。个人设置署名提示同步此前投稿快照规则。
- Discord 回调失败日志不再打印可能带上游响应的完整 Error。

## 旧账号与边界

- 既有 Discord 绑定按 provider + immutable Discord ID 找到原 User，保留原余额，不重新赠送。
- 仍有有效会话、尚未绑定的邮箱用户可从 `/settings` 绑定 Discord；回调先验证群成员，再写当前 User 的绑定，不创建新 User、不改积分。Discord 已绑定其他 User 时沿用冲突拒绝。
- 没有旧会话且未绑定的普通邮箱用户不能再靠邮箱密码进入；登录页说明应联系管理员，不自动合并普通邮箱账号或转移积分。原共享 helper 对无密码、无绑定的合成占位邮箱历史兼容保留，没有扩展为用户邮箱匹配。
- 当前有效旧会话和既有 API Key 的权限/到期边界不变；本次没有新增后台退群轮询或即时会话撤销。群验证发生在新的 Discord 登录/绑定。封禁仍由既有每请求用户检查执行。
- 没有改首次 500 积分、签到、邀请码历史记录、邮箱密码哈希、账号数据及管理员恢复凭据。

## 回归证据

新增真实路由/页面用例先红：路由策略 7 项（普通邮箱原 200、LinuxDo 原 307 等）、空群配置 2 项（原 307）、公开页面 4 项（旧邮箱/邀请入口）均复现。主代理补充密码校验顺序后，新增枚举差异回归先红（403 ≠ 401），再调整顺序通过。

最终命令：

```text
node node_modules/vitest/vitest.mjs run src/tests/unit/public-auth-policy.test.ts src/tests/unit/public-login-page.test.tsx src/tests/unit/register-route-bootstrap.test.ts src/tests/unit/discord-oauth.test.ts src/tests/unit/auth-form.test.tsx src/tests/unit/auth-form-submission.test.tsx src/tests/unit/linuxdo-oauth.test.ts --maxWorkers=2
```

7 套 63 例通过（2026-11-21 02:09 本机输出）。覆盖管理员验证码/限频/错误密码/封禁/成功恢复、普通账号正确密码拒绝与错误密码一致性、角色伪造、领码关闭、LinuxDo 关闭、群配置缺失、非成员/待验证、原绑定保留额度、旧邮箱有效会话绑定、密码账号不凭占位邮箱接管、解绑最后登录方式及页面旧入口重定向。沿用原 AuthForm 网络错误和验证码生命周期测试。

全量 `tsc --noEmit --incremental false` 通过；本次 21 个相关 TypeScript 文件 ESLint 通过；`git diff --check` 通过（仓库既有 LF/CRLF 提示不涉及空白错误）。未运行生产 OAuth 授权、创建账号、领码或退出群。生产 HTTP smoke 由主代理按新版 `/login`、恢复参数、403 接口和两处重定向调整；本次单测不冒充线上 Discord 服务验证。

## 独立复核后的旧登录源兼容补充

Studio 发现原设置 UI 用“已有任何 OAuth 绑定”遮住了 Discord 按钮：旧 LinuxDo 会话因此无法在页面迁移。经主代理授权，保留/解绑区现仅匹配已绑定 Discord；其他旧来源仍显示 Discord 绑定入口，并明确替换原登录绑定、保留账号数据。沿用原 `linkOAuthAccount` 仅依赖有效站内会话且检查目标 Discord 冲突的能力，未增加按邮箱合并。

同步修正个人资料区三处旧文案：投稿默认匿名、可选择当时昵称快照、修改昵称不改变已有投稿；邮箱是记录展示，普通登录只用 Discord，已有管理员密码恢复例外。

新增 `profile-form-auth-policy.test.tsx` 五个用例，旧 LinuxDo 缺按钮与旧署名说明两项先失败，修改后通过；Discord 回调既有绑定测试扩为邮箱/旧 LinuxDo 两种有效会话，均验证更新同一 User、无建号或积分改写。最终这四套受影响测试（profile form、Discord callback、public auth policy、public login page）36/36 通过；三份变动文件 ESLint 和差异检查通过。完整构建由主代理统一执行，避免与其全量检查/构建争用目录。
