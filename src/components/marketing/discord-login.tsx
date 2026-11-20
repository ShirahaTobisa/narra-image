type DiscordLoginProps = {
  enabled: boolean;
  error: string | null;
};

export function DiscordLogin({ enabled, error }: DiscordLoginProps) {
  return (
    <div className="space-y-5">
      {error ? <p role="alert" className="text-sm text-rose-600">{error}</p> : null}
      {enabled ? (
        <>
          <a href="/api/auth/oauth/discord" className="auth-oauth-btn">使用 Discord 登录</a>
          <p className="text-sm leading-relaxed text-[var(--ink-soft)]">
            请先加入指定的 Discord 服务器并完成入群验证。首次登录会自动创建账号。
          </p>
        </>
      ) : (
        <p role="status" className="text-sm text-[var(--ink-soft)]">Discord 登录暂不可用，请联系管理员。</p>
      )}
      <p className="text-xs leading-relaxed text-[var(--ink-soft)]">
        已有邮箱账号：请在仍登录的设备上进入个人设置绑定 Discord；已退出且未绑定时请联系管理员。
      </p>
    </div>
  );
}
