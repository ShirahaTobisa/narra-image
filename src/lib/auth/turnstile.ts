import "server-only";

import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from "@/lib/providers/provider-secret";

export type TurnstileScope =
  | "login"
  | "register"
  | "inviteRedeem"
  | "generate";

const SCOPE_FIELD: Record<TurnstileScope, "protectLogin" | "protectRegister" | "protectInviteRedeem" | "protectGenerate"> = {
  login: "protectLogin",
  register: "protectRegister",
  inviteRedeem: "protectInviteRedeem",
  generate: "protectGenerate",
};

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5000;

async function getOrCreateConfig() {
  const existing = await db.turnstileConfig.findUnique({
    where: { scope: "default" },
  });
  if (existing) return existing;

  return db.turnstileConfig.create({
    data: { scope: "default" },
  });
}

export async function getTurnstileConfig() {
  return getOrCreateConfig();
}

export type PublicTurnstileConfig = {
  isEnabled: boolean;
  siteKey: string | null;
  protectLogin: boolean;
  protectRegister: boolean;
  protectInviteRedeem: boolean;
  protectGenerate: boolean;
};

export async function getPublicTurnstileConfig(): Promise<PublicTurnstileConfig> {
  const cfg = await getOrCreateConfig();
  const usable = cfg.isEnabled && Boolean(cfg.siteKey) && Boolean(cfg.secretEncrypted);
  return {
    isEnabled: usable,
    siteKey: usable ? cfg.siteKey : null,
    protectLogin: cfg.protectLogin,
    protectRegister: cfg.protectRegister,
    protectInviteRedeem: cfg.protectInviteRedeem,
    protectGenerate: cfg.protectGenerate,
  };
}

export async function isTurnstileRequired(scope: TurnstileScope) {
  const cfg = await getOrCreateConfig();
  if (!cfg.isEnabled || !cfg.siteKey || !cfg.secretEncrypted) return false;
  return cfg[SCOPE_FIELD[scope]];
}

export async function updateTurnstileConfig(input: {
  isEnabled?: boolean;
  siteKey?: string | null;
  secretKey?: string | null;
  protectLogin?: boolean;
  protectRegister?: boolean;
  protectInviteRedeem?: boolean;
  protectGenerate?: boolean;
}) {
  const env = getEnv();
  await getOrCreateConfig();

  const data: Record<string, unknown> = {};
  if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;
  if (input.siteKey !== undefined) data.siteKey = input.siteKey || null;
  if (input.protectLogin !== undefined) data.protectLogin = input.protectLogin;
  if (input.protectRegister !== undefined) data.protectRegister = input.protectRegister;
  if (input.protectInviteRedeem !== undefined) data.protectInviteRedeem = input.protectInviteRedeem;
  if (input.protectGenerate !== undefined) data.protectGenerate = input.protectGenerate;
  if (input.secretKey !== undefined) {
    data.secretEncrypted = input.secretKey
      ? await encryptProviderSecret(input.secretKey, env.AUTH_SECRET)
      : null;
  }

  return db.turnstileConfig.update({
    where: { scope: "default" },
    data,
  });
}

type SiteVerifyResponse = {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
};

/** 把 token 交给 Cloudflare 核对，5 秒没回就中止 */
async function siteVerify(secret: string, token: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }).toString(),
      signal: controller.signal,
    });
    return (await response.json()) as SiteVerifyResponse;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyTurnstileToken(token: string): Promise<{
  ok: boolean;
  reason?: string;
}> {
  if (!token) return { ok: false, reason: "missing-token" };

  const cfg = await getOrCreateConfig();
  if (!cfg.secretEncrypted) {
    return { ok: false, reason: "secret-not-configured" };
  }

  let secret: string;
  try {
    secret = await decryptProviderSecret(cfg.secretEncrypted, getEnv().AUTH_SECRET);
  } catch {
    return { ok: false, reason: "secret-decrypt-failed" };
  }

  try {
    const data = await siteVerify(secret, token);
    if (!data.success) return { ok: false, reason: data["error-codes"]?.join(",") || "verify-failed" };
    // 只认在本站页面上完成的验证：Key 里要是还加了 localhost 之类的域名，那边拿到的结果不能拿来这里用
    if (data.hostname !== new URL(getEnv().APP_URL).hostname) return { ok: false, reason: "hostname-mismatch" };
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.name === "AbortError" ? "timeout" : "network-error",
    };
  }
}

/** 保存前核对 Secret Key：拿假 token 去问 Cloudflare，它明确说 Secret Key 不对才算填错；连不上就不拦 */
export async function isTurnstileSecretRejected(secret: string) {
  try {
    const data = await siteVerify(secret, "secret-key-check");
    return Boolean(data["error-codes"]?.includes("invalid-input-secret"));
  } catch {
    return false;
  }
}

export async function requireTurnstile(scope: TurnstileScope, token: string | undefined) {
  if (!(await isTurnstileRequired(scope))) return;
  const result = await verifyTurnstileToken(token ?? "");
  if (!result.ok) {
    throw new Error(`人机验证失败：${result.reason ?? "unknown"}`);
  }
}
