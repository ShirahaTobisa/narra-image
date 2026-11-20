"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Sparkles } from "lucide-react";
import { postJson } from "@/lib/http-client";

import {
  TurnstileWidget,
  type TurnstileWidgetHandle,
} from "@/components/auth/turnstile-widget";

type OAuthProvider = {
  type: string;
  displayName: string;
  inviteExempt?: boolean;
};

export type AuthFormTurnstile = {
  isEnabled: boolean;
  siteKey: string | null;
  protectLogin: boolean;
  protectRegister: boolean;
};

type AuthFormProps = {
  initialInviteCode?: string;
  mode: "login" | "register";
  oauthError?: string | null;
  oauthProviders?: OAuthProvider[];
  turnstile?: AuthFormTurnstile | null;
};

export function AuthForm({
  mode,
  initialInviteCode = "",
  oauthProviders = [],
  oauthError = null,
  turnstile = null,
}: AuthFormProps) {
  const router = useRouter();
  const [isNavigating, startTransition] = useTransition();
  const [pendingScope, setPendingScope] = useState<object | null>(null);
  const submissionRef = useRef<{ scope: object; pending: boolean } | null>(null);
  const [error, setError] = useState<string | null>(oauthError);
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [challenge, setChallenge] = useState<{ scope: object; token: string } | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);

  const requireTurnstile =
    Boolean(turnstile?.isEnabled && turnstile?.siteKey) &&
    (mode === "login" ? !!turnstile?.protectLogin : !!turnstile?.protectRegister);
  const challengeScope = `${mode}:${requireTurnstile}:${turnstile?.siteKey ?? ""}`;
  const scope = useMemo(() => ({ challengeScope }), [challengeScope]);
  const turnstileToken = challenge?.scope === scope ? challenge.token : null;
  const isPending = pendingScope === scope || isNavigating;

  useEffect(() => {
    submissionRef.current = { scope, pending: false };
    return () => { submissionRef.current = null; };
  }, [scope]);

  async function handleSubmit(formData: FormData) {
    const submission = submissionRef.current;
    if (!submission || submission.scope !== scope || submission.pending) return;
    const isCurrent = () => submissionRef.current === submission;
    setError(null);

    if (requireTurnstile && !turnstileToken) {
      setError("请先完成人机验证");
      return;
    }

    const payload =
      mode === "register"
        ? {
            email: String(formData.get("email") || ""),
            inviteCode: String(formData.get("inviteCode") || ""),
            password: String(formData.get("password") || ""),
            ...(turnstileToken ? { turnstileToken } : {}),
          }
        : {
            email: String(formData.get("email") || ""),
            password: String(formData.get("password") || ""),
            ...(turnstileToken ? { turnstileToken } : {}),
          };

    submission.pending = true;
    setPendingScope(scope);
    setChallenge(null);
    let succeeded = false;
    try {
      const result = await postJson<{ user?: { role: "user" | "admin" } }>(
        mode === "register" ? "/api/auth/register" : "/api/auth/login", payload,
      );
      if (!isCurrent()) return;
      if (result.user?.role !== "user" && result.user?.role !== "admin") {
        throw new Error("登录结果不完整，请稍后再试");
      }
      succeeded = true;
      startTransition(() => {
        if (!isCurrent()) return;
        router.push(result.user?.role === "admin" ? "/admin" : "/create");
        router.refresh();
      });
    } catch (error) {
      if (isCurrent()) setError(error instanceof Error ? error.message : "请求失败，请稍后再试");
    } finally {
      submission.pending = false;
      // token 是一次性的，网络或解析失败也可能已经消耗它。
      if (isCurrent()) {
        setPendingScope(null);
        if (requireTurnstile && !succeeded) turnstileRef.current?.reset();
      }
    }
  }

  function buildOAuthHref(providerType: string) {
    const trimmed = inviteCode.trim();
    if (!trimmed) return `/api/auth/oauth/${providerType}`;
    return `/api/auth/oauth/${providerType}?inviteCode=${encodeURIComponent(trimmed)}`;
  }

  const hasOAuth = oauthProviders.length > 0;
  // 限定了服务器的 Discord 不用邀请码，只有别的登录方式才提示填
  const inviteProvider = oauthProviders.find((provider) => !provider.inviteExempt);
  const exemptNames = oauthProviders
    .filter((provider) => provider.inviteExempt)
    .map((provider) => provider.displayName)
    .join("、");

  return (
    <div className="grid gap-5">
      <form onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit(new FormData(event.currentTarget));
      }} className="grid gap-4">
        <div className="grid gap-2">
          <label htmlFor="auth-email" className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--ink-soft)]">
            邮箱
          </label>
          <input
            id="auth-email"
            name="email"
            type="email"
            autoComplete={mode === "register" ? "email" : "username"}
            required
            placeholder="you@example.com"
            className="auth-input"
          />
        </div>

        {mode === "register" ? (
          <div className="grid gap-2">
            <label htmlFor="auth-invite" className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--ink-soft)]">
              邀请码
            </label>
            <input
              id="auth-invite"
              name="inviteCode"
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              placeholder="请输入邀请码"
              className="auth-input uppercase"
            />
          </div>
        ) : null}

        <div className="grid gap-2">
          <label htmlFor="auth-password" className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--ink-soft)]">
            密码
          </label>
          <input
            id="auth-password"
            name="password"
            type="password"
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            required
            placeholder="至少 8 位"
            className="auth-input"
          />
        </div>

        {requireTurnstile && turnstile?.siteKey ? (
          <div className="flex justify-center">
            <TurnstileWidget
              key={challengeScope}
              ref={turnstileRef}
              siteKey={turnstile.siteKey}
              onVerify={(token) => setChallenge({ scope, token })}
              onExpire={() => setChallenge(null)}
              onError={() => setChallenge(null)}
            />
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="rounded-2xl border border-rose-200/80 bg-rose-50/80 px-4 py-3 text-sm text-rose-600 backdrop-blur"
          >
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={isPending || (requireTurnstile && !turnstileToken)}
          className="auth-submit-btn mt-2"
        >
          <span className="flex items-center justify-center gap-2">
            {isPending
              ? "处理中..."
              : mode === "register"
                ? "注册并进入创作台"
                : "登录进入创作台"}
            {!isPending ? <ArrowRight className="size-4" /> : null}
          </span>
        </button>
      </form>

      {hasOAuth ? (
        <>
          <div className="flex items-center gap-3 px-1 py-2 text-[11px] uppercase tracking-[0.28em] text-[var(--ink-soft)]/80">
            <span className="h-px flex-1 bg-[var(--line)]" />
            或使用第三方登录
            <span className="h-px flex-1 bg-[var(--line)]" />
          </div>

          <div className="grid gap-3">
            {oauthProviders.map((provider) => (
              <a
                key={provider.type}
                href={buildOAuthHref(provider.type)}
                className="auth-oauth-btn"
              >
                <Sparkles className="size-4 text-[var(--accent)]" />
                <span>使用 {provider.displayName} 登录</span>
              </a>
            ))}

            {exemptNames ? (
              <p className="text-[11px] leading-5 text-[var(--ink-soft)]/80">
                指定 {exemptNames} 服务器的成员直接登录，不用邀请码。
              </p>
            ) : null}

            {inviteProvider && mode === "register" ? (
              <p className="text-[11px] leading-5 text-[var(--ink-soft)]/80">
                新用户使用 {inviteProvider.displayName} 注册需先填写上方邀请码；
                已绑定账号可直接登录，无需邀请码。
              </p>
            ) : null}

            {inviteProvider && mode === "login" ? (
              <details className="auth-collapse">
                <summary>
                  <span>需要邀请码？首次第三方登录请填写</span>
                </summary>
                <input
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                  placeholder="请输入邀请码"
                  className="auth-input mt-3 w-full uppercase"
                />
                <p className="mt-2 text-[11px] leading-5 text-[var(--ink-soft)]/80">
                  老用户登录可留空；首次绑定第三方账号时邀请码用于消耗名额。
                </p>
              </details>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
