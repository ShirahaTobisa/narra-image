import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/marketing/auth-form";
import { AuthShell } from "@/components/marketing/auth-shell";
import { DiscordLogin } from "@/components/marketing/discord-login";
import { getEnabledOAuthProviders } from "@/lib/auth/oauth-config";
import { getPublicTurnstileConfig } from "@/lib/auth/turnstile";
import { fromPrismaRole } from "@/lib/prisma-mappers";
import { getCurrentUserRecord } from "@/lib/server/current-user";
import { getAuthCover } from "@/lib/server/auth-cover";

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams?: Promise<{
    error?: string;
    admin?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const user = await getCurrentUserRecord();
  if (user) {
    redirect(fromPrismaRole(user.role) === "admin" ? "/admin" : "/create");
  }

  const resolvedParams = searchParams ? await searchParams : undefined;
  const oauthError =
    typeof resolvedParams?.error === "string" ? resolvedParams.error : null;
  const adminRecovery = resolvedParams?.admin === "1";

  const [oauthProviders, turnstile, coverProps] = await Promise.all([
    adminRecovery ? [] : getEnabledOAuthProviders(),
    adminRecovery ? getPublicTurnstileConfig() : null,
    getAuthCover(),
  ]);

  return (
    <AuthShell
      eyebrow="Secure Access"
      title="WelcomeBack"
      description={adminRecovery ? "仅供现有管理员使用邮箱和密码恢复登录。" : "使用 Discord 进入 Narra Image 创作台，积分与作品保存在你的账号中。"}
      {...coverProps}
      coverCaption="Featured Vision"
      footnote={
        <Link href={adminRecovery ? "/login" : "/login?admin=1"} className="font-medium text-[var(--accent)]">
          {adminRecovery ? "返回 Discord 登录" : "管理员恢复登录"}
        </Link>
      }
    >
      {adminRecovery ? (
        <AuthForm
          mode="login"
          oauthError={oauthError}
          turnstile={turnstile ? {
            isEnabled: turnstile.isEnabled,
            siteKey: turnstile.siteKey,
            protectLogin: turnstile.protectLogin,
            protectRegister: turnstile.protectRegister,
          } : null}
        />
      ) : (
        <DiscordLogin enabled={oauthProviders.some(({ type }) => type === "discord")} error={oauthError} />
      )}
    </AuthShell>
  );
}
