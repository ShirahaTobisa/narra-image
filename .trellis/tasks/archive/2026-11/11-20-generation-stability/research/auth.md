# 登录、人机验证与页面异常

- 日期：2026-11-20
- 范围：源码、现有测试、线上匿名 GET；未尝试登录或修改线上数据。

## 已确认问题

1. `src/components/marketing/auth-form.tsx:78` 的 fetch 与 JSON 解析没有异常处理；断网或网关返回 HTML 时，form action 抛出异常，会进入错误边界。`isPending` 仅包住成功后的跳转，等待请求期间按钮仍可点。应将整个提交纳入 pending，防重复，错误留在原表单，失败后清除一次性验证码。
2. `src/components/auth/turnstile-widget.tsx:39` 的模块级 `scriptPromise` 失败后永久保留 rejected Promise；SPA 导航或重新挂载仍然失败。加载也无截止时间，网络挂起会一直显示加载中。应共用进行中的加载、清理失败脚本、允许就地重试，并在卸载后拒绝旧回调。
3. `src/components/benefits/check-in-button.tsx:28` 和 `src/components/invites/invite-claim-board.tsx:44` 在 async transition 中有同样的 fetch/JSON 未捕获异常。邀请码请求异常还跳过 token 清理。三处可共用小型、有截止时间的 JSON POST helper，各自显示错误。

## 卡顿证据与边界

匿名 GET 实测：login HTTP 200，TTFB 0.206s，总耗时 0.245s，约 27KB；register HTTP 200，总耗时 0.144s。HTML 包含完整登录表单和验证码加载占位，没有服务端错误标记。当前证据不支持把用户感到的卡顿归咎于服务器渲染；优先修复脚本无限等待、提交无反馈和失败后无法恢复。

登录/注册都无条件查询精选封面，即使配置为自定义；这是可以优化的重复查询，但本轮缺少它造成明显延迟的证据，不扩大范围。

## 参考资料

- Cloudflare 官方显式加载说明：https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/ 。保留官方脚本直连，SPA 使用显式 render，不代理/缓存脚本。
- Discord 官方 OAuth 说明：https://github.com/discord/discord-api-docs/blob/main/developers/topics/oauth2.mdx 。当前 `prompt=none` 的行为未能据此证明存在独立故障，本轮不更改登录资格或授权策略。

## 验证要求

- 登录断网、HTML 错误、超时均留在表单且可重试；请求期间禁用重复提交。
- 验证码失败后能够重载；脚本超时有可见提示；旧挂载回调不改变新挂载状态；模式变化不复用旧 token。
- 签到/领取失败可见且不导航错误页；领取异常后重置验证码。
- 不放宽服务端验证码校验。

## 已实施与验证

- 新增 `src/lib/http-client.ts`，给登录、注册、签到与邀请码领取复用 JSON POST、30 秒截止、网络/非 JSON 错误转换。
- 登录表单改为普通 submit 处理，立即显示等待状态并用 ref 防重复；按登录模式/站点密钥隔离 token，失败时重置验证。
- Turnstile 加载使用 15 秒截止，共享仅进行中的 Promise，失败清理脚本并提供“重新验证”按钮；旧实例回调退出，保留官方脚本和服务端验证。
- 签到错误现在可见；邀请码请求失败后恢复，所有批次共用领取锁，避免同一 token 同时领取。
- 修复前 `auth-form-submission.test.tsx` 四个回归全部失败（`auth-red.log`）。
- 修复后 5 个相关测试文件、21 条用例通过（`auth-tests.log`）。定向 ESLint 通过（`auth-lint.log`）。全量与更新依赖后的重跑由主代理负责。
- 未改变登录/注册服务器页面、OAuth 权限或服务端验证码校验。没有进行真实账号登录和第三方验证端到端操作。

## 独立审阅后的补充

- 登录请求捕获当前模式/站点密钥的提交作用域。模式/密钥切换或卸载后，旧请求不显示错误、不清除新 token、不重置新验证码、不导航；新作用域可自行提交，POST 不自动重试。
- 邀请码领取离开页面后，迟到结果不更新状态或把用户导航回注册页。
- 更新依赖后重新验证：5 个测试文件、26 条用例通过；增加在途请求后模式/密钥切换、卸载和领取离页回归。
