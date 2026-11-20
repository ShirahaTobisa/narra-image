import { redirect } from "next/navigation";

import { SiteHeader } from "@/components/marketing/site-header";
import { ProfileForm } from "@/components/settings/profile-form";
import { db } from "@/lib/db";
import { getEnabledOAuthProviders } from "@/lib/auth/oauth-config";
import { canUsePasswordLogin } from "@/lib/auth/access-policy";
import { OAUTH_PROVIDER_LABELS } from "@/lib/constants";
import { serializeUser } from "@/lib/prisma-mappers";
import { getCurrentUserRecord } from "@/lib/server/current-user";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "个人设置 — Narra Image",
  description: "管理你的个人资料、昵称、头像和积分信息。",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUserRecord();
  if (!user) {
    redirect("/login");
  }

  const params = await searchParams;
  const oauthProviders = await getEnabledOAuthProviders();
  const linkedLabel =
    typeof params.linked === "string" ? OAUTH_PROVIDER_LABELS[params.linked] : undefined;
  const queryNotice: { hint: "linked" | "error"; message: string } | null =
    linkedLabel
      ? { hint: "linked", message: `已成功绑定 ${linkedLabel} 账号` }
      : typeof params.error === "string" && params.error.length > 0
        ? { hint: "error", message: params.error }
        : null;

  const currentUser = serializeUser(user);
  const hasPassword =
    (await db.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    }))?.passwordHash != null;

  return (
    <main className="pb-20">
      <SiteHeader currentUser={currentUser} />

      <section className="mx-auto grid max-w-7xl gap-5 px-5 pb-12 pt-8 md:px-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-[var(--ink)] md:text-4xl">
            个人设置
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--ink-soft)]">
            管理你的昵称、头像等个人资料。投稿时可选择公开当前昵称，已投稿署名不会随个人资料变化。
          </p>
        </div>

        <ProfileForm
          user={currentUser}
          oauthProvider={user.oauthProvider}
          canUnlinkOAuth={hasPassword && canUsePasswordLogin(user.role)}
          oauthProviders={oauthProviders}
          queryNotice={queryNotice}
        />
      </section>
    </main>
  );
}
