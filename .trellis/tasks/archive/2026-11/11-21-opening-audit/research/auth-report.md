# 注册、群资格与封禁报告复核

复核基线：本地 HEAD `da7915a`（任务说明中的已部署产品代码为 `1c50f24`）。只读检查源码、现有单元测试和 Discord 官方文档；未连接生产、读取密钥、改产品代码或账户。本文件中的线上开关/邀请码库存不沿用旧报告作为当前事实。

## 报告版本变化

研究过程中，源报告 `D:/tools/claude/reports/narra-image-开站排查-2026-11-21.md` 更新到本地修改时间 `2026-11-21 01:16:16`：原先分派的“小号/号龄”已不在编号 2；新的第 2 项是公开作品昵称隐私，已通知主代理交给作品审阅。接手须知新增“一人多号不处理，发现后封禁”。以下仍保留分派要求的号龄事实核对，不把报告建议当成改变站点规则的授权。

## 结论概览

| 项目 | 当前结论 | 建议范围 |
| --- | --- | --- |
| 旧 #2：小号、号龄和入群时长 | 代码按 Discord 身份给新用户初始积分，不按自然人去重；无号龄/入群时长门槛。这是现有运营规则，不是同一账户重复登录自动刷分。 | 不增加阈值、IP 绑定或识别框架；记录事实即可。 |
| #5：退群后旧会话 | 成立。网页登录在原签发后剩余最多 14 天内仍可用。若 API 已启用且有有效 Key，则没有这个 14 天上限。 | 立即处置使用已有站内封禁。自动同步退群需明确资格持续性及复查机制，不凭空定时限。 |
| #6：管理员删除后重新获赠 | 成立，但需要管理员主动删除；普通用户不能自行删号。删除也清除该 User 的封禁和审核记录。 | 最小确定改进是删除确认明确提示“不能代替封禁；同一第三方账户可重注册并获赠”。不要静默把删除改成封禁或保留身份的新制度。 |
| #11：邮箱/邀请码绕开群限制 | 当前邮箱密码、邀请码注册、LinuxDo 与 Discord 群检查是独立入口。有效邀请码确实可建立没有 Discord 资格的账户。 | 是否全站仅允许群成员属于登录规则选择；隐藏链接不等于接口限制。不要擅自封掉现有邮箱管理员入口。 |
| “兑换码和新号积分刷不了” | 过度概括。同一现存账户重复登录不再赠送，同一兑换码对同一 User 有唯一限制；多身份、管理员删号后的新 User 是另一回事。 | 将保证范围写准确；无需因此擅改每号 500 分和签到规则。 |

## 旧 #2：没有按自然人限领，也没有号龄门槛

- `src/app/api/auth/oauth/discord/callback/route.ts:61` 在查找/创建用户前检查配置的群列表；非空列表中任意一个群合格即可，然后在 `:88` 传 `inviteExempt: true`。
- `src/lib/auth/discord-oauth.ts:109` 逐群调用 `/users/@me/guilds/{id}/member`，404 跳到下一个，其他非成功状态抛错，不会放行。`:123` 只读取 `pending`，拒绝 `pending === true`；没有使用 `joined_at`，也没有计算 Discord ID 的时间。
- `src/lib/auth/oauth-accounts.ts:68` 先按 `oauthProvider + oauthId` 取现有用户；`:79` 已封禁则拒绝。已有用户只更新头像/缺失昵称，不重置余额。只有 `:123` 创建数据使用 `DEFAULT_INITIAL_CREDITS`，`:133` 对合格群成员直接建号。`src/lib/constants.ts:1` 当前是 500。
- 因而多开账户的实际前提是获得多个 Discord 身份、分别通过允许群的当前成员检查；每个新身份按规则获赠。无法据此证明一次请求可重复加分。当前每分钟限额已是 `src/lib/server/generation-rate-limit.ts:9` 的每个站内 User 五张，而非旧报告所写五次；它也不合并多账号。
- 官方数据足以在未来实现“号龄/入群时长”，但技术上能取到不代表应该新增限制。Snowflake 含创建时间；成员对象的 `joined_at` 可为空，`pending` 表示未完成 Membership Screening，并不是“同一个自然人”证明。[Discord ID 文档](https://docs.discord.com/developers/reference#snowflakes)、[成员对象](https://docs.discord.com/developers/resources/guild#guild-member-object)、[当前用户群成员接口](https://docs.discord.com/developers/resources/user#get-current-user-guild-member)。不要把 `pending` 缺省直接改为拒绝：官方字段是可选。

现有 `discord-oauth.test.ts` 覆盖任一群、全不在群、pending、首次免邀请码及 state 错误；共享账户逻辑在 `linuxdo-oauth.test.ts` 覆盖现有绑定、已封禁、邀请码竞争和纯 OAuth 禁止解绑。若后续改动这些流程，补明确的“同 Discord ID 重登保持现有积分”断言；无需为尚未选择的号龄政策编写实现。

## #5：群资格只在 OAuth 回调查询

- `src/lib/auth/session-token.ts:5` 定义 14 天；`:38` 固定 `exp = 签发时间 + 14 天`。`src/lib/auth/session.ts:57` 的 cookie 同为 14 天。退群不会重新给 14 天，只是原会话未到期仍可用。
- `src/lib/server/current-user.ts:15` 每次请求读取用户，`:31` 拒绝不存在或 `bannedAt` 用户；不访问 Discord。JWT 只持有用户、角色及时间，不含群资格。OAuth 换到的访问令牌仅用于本次回调，没有数据库持久化的 access/refresh token 或群检查时间。
- API 更长：`prisma/schema.prisma:422` 的 ApiKey 只有 `revokedAt`，没有到期字段；`src/lib/server/api-auth.ts:28` 先检查站点 API 开关，`:58` 检查 Key 和用户封禁，但不查 Discord。此边界需“API 开启、已有未撤销 Key、站内未封禁”才发生；不声称生产现在开着 API。
- 站内封禁仍有效：`src/app/api/admin/users/[id]/ban/route.ts:32` 更新 `bannedAt`；网页和 API 的下一次授权都会拒绝。它不是从浏览器删除旧 cookie，也不等于已接受任务立即中止（排队任务由另一项研究覆盖）。

最小处置是继续使用现有站内封禁；“退群应自动撤销资格”若成为需求，需要明确是否包含 API/邮箱替代登录、容许多久复查及 Discord 故障时行为。现有代码没有可复用的长效群查询凭据，不能只在 `current-user.ts` 多放一次 fetch 就正确解决。短会话只能缩短旧网页会话窗口，无法覆盖 API 或另一登录入口，不能标为完整修复。

必要回归：真实签名会话在到期边界拒绝；有效会话对应用户被封后网页授权拒绝；有效 API Key 对封禁用户拒绝。若以后加入资格复查，还需覆盖退出所有允许群、仍在另一允许群、复查失败、API 与网页一致、既有管理员恢复入口。现有 `session-token.test.ts` 仅测签发往返和错误密钥，没有到期边界用例。

## #6：删除不是封禁，删除后没有身份级赠送记账

- `src/app/api/admin/users/[id]/route.ts:178` 要求管理员，`:182` 禁止删自己；`:193` 直接 `db.user.delete`。没有普通用户自删账户的路由。`src/lib/auth/oauth-accounts.ts:254` 也禁止没有密码的纯 OAuth 用户解绑。
- Discord 绑定和 `bannedAt` 就是 `prisma/schema.prisma:111` 的 User 列，不是独立保留的身份记录；`ContentReview.user` 在 `:157` 使用 Cascade。没有保留“这个 Discord 身份已领过初始积分/被封”的独立账本。
- 删除成功后，同一 Discord 用户仍满足允许群条件，再走回调会找不到旧 User/占位邮箱，于是创建新的 User 并给 500。若还在群内，旧站内封禁也随删除消失；若已被移出所有允许群，下一次 Discord 登录仍会被群检查挡住，不是无条件回来。
- `users-management-board.tsx:452` 附近确有相邻封禁/删除按钮；`:573` 的确认文案说明删除记录与不可撤销，却没说明重新注册/重新获赠后果。已有确认弹窗，因此并非点图标就直接删除。
- 删除还 Cascade `RedeemRedemption`（schema `:402`），但不递减兑换码的全局 `redeemedCount`。重新注册的新 User 对仍有总额度的共享兑换码可以再兑；已经耗尽的一次码不会因此恢复可用。不要把这描述为同一现存用户绕过唯一约束。

建议先只补准确的删除提示，并在管理说明中用封禁处理违规用户。如果站长以后要求“删账户也永久记住封禁/赠送”，需要明确保留哪些外部身份数据，再实现独立记账或软删除；这不是本次可以擅改的数据保留规则。不要为了验证实际删除线上账户。

现有 `admin-user-delete-route.test.ts` 覆盖管理员删除、禁止自删、不存在和非管理员；若只改提示，验证确认界面的信息即可。若将来增加保留身份策略，必须以数据库事务回归删除→同 Discord 重登、并发首次建号以及封禁不能通过替代绑定逃逸，不能只靠 mock create 次数断言。

## #11：邮箱/邀请码是另一种授权，不自动继承 Discord 群规则

- `src/app/login/page.tsx:46`、`:50` 公开注册/领码链接，`:56` 渲染邮箱登录表单；`register/page.tsx:63` 始终提供邀请码注册。`invite-claim/page.tsx:15` 只列公开批次。
- `src/app/api/auth/register/route.ts:18` 执行人机验证，`:38` 校验未使用邀请码，事务内建账户并条件占用邀请码（`:83`）；没有 Discord 资格检查。有效未用邀请码、有效表单、通过当前 Turnstile 即可走这条路径。无邀请码仍不能注册；旧报告说的“库存只剩已用一个”未经本次生产核实。
- 领码 API `src/app/api/invites/batches/[id]/claim/route.ts:15` 验证 Turnstile；`src/lib/invites/claim-invite.server.ts:9` 要求公开批次及未领/未用码，并条件更新占用。它不要求 Discord 会话。公开批次存在时，同一人可取得多个不同码；原有一个码不会在并发中合法发给多人。
- `src/app/api/auth/login/route.ts:14` 至 `:64` 验证邮箱、密码、人机验证、站内封禁后签发会话，不检查 Discord。没有密码的纯 OAuth 用户被 `:45` 拒绝，不能凭占位邮箱直接登录。
- 如启用 LinuxDo，`src/app/api/auth/oauth/linuxdo/callback/route.ts:62` 只额外要求该提供商账户 active，然后走共享账户/邀请码流程，也没有 Discord 群检查。`allowedGuildId` 是 Discord provider 的配置，不是全站登录限制。

“邀请码/兑换码”功能存在不等于售卖或收费；相关文案是否适合社区需要运营决定。若只修文案，不应宣称关闭了替代登录。若明确选择仅 Discord 群成员可用，必须服务器统一约束注册、登录及已有账户/API，不只删前端按钮；同时先明确现有邮箱管理员的恢复登录方式，避免锁管理员。不要擅自禁用现存正常用户。

必要回归（仅在确定政策并修改时）：直接 POST 邮箱注册/登录不能靠隐藏页面绕过；邀请有效与无效、公共领码、LinuxDo、现存邮箱账户、管理员恢复入口都按同一规则；拒绝发生在建用户、消耗邀请码之前。现有注册/领码测试没有“Discord-only 全站”用例，因为代码本来没有这项策略。

## “刷不了”的可支持范围

同一个现存 OAuth 身份重登不重新赠送；邮箱 unique 和事务内邀请码 `usedAt: null` 的条件占用限制同码注册。`src/lib/redeem-codes.ts:41` 检查单 User 是否已兑，`:54` 原子增加不超过上限的兑换次数，`:73` 写兑换记录；`prisma/schema.prisma:404` 的 `(codeId, userId)` 唯一约束和事务保证同一 User 的并发重复不会重复加分。

这些保证不能推出“一个自然人永远不能多领”，也不能推出“删除 User 后仍识别原来身份”。建议把旧报告绝对表述改成上述具体边界。现有 `redeem-code.test.ts` 只以 mock 覆盖已兑换/耗尽/首次成功，不能将其当成真实数据库并发验证。本次未执行生产试注册、兑换、退出群或删号，未跑额外测试；结论是当前代码路径与约束审阅。
