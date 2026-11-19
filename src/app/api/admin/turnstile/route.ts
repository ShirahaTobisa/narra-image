import { z } from "zod";

import {
  getTurnstileConfig,
  isTurnstileSecretRejected,
  updateTurnstileConfig,
} from "@/lib/auth/turnstile";
import { requireAdminRecord } from "@/lib/server/current-user";
import {
  getErrorMessage,
  jsonError,
  jsonOk,
  parseJsonBody,
} from "@/lib/server/http";

const patchSchema = z.object({
  isEnabled: z.boolean().optional(),
  siteKey: z.string().nullable().optional(),
  secretKey: z.string().nullable().optional(),
  protectLogin: z.boolean().optional(),
  protectRegister: z.boolean().optional(),
  protectInviteRedeem: z.boolean().optional(),
  protectGenerate: z.boolean().optional(),
});

function serialize(cfg: Awaited<ReturnType<typeof getTurnstileConfig>>) {
  return {
    isEnabled: cfg.isEnabled,
    siteKey: cfg.siteKey ?? "",
    secretConfigured: Boolean(cfg.secretEncrypted),
    protectLogin: cfg.protectLogin,
    protectRegister: cfg.protectRegister,
    protectInviteRedeem: cfg.protectInviteRedeem,
    protectGenerate: cfg.protectGenerate,
    updatedAt: cfg.updatedAt.toISOString(),
  };
}

export async function GET() {
  try {
    await requireAdminRecord();
    const cfg = await getTurnstileConfig();
    return jsonOk({ config: serialize(cfg) });
  } catch (error) {
    return jsonError(getErrorMessage(error), 403);
  }
}

export async function PATCH(request: Request) {
  try {
    await requireAdminRecord();
    const body = patchSchema.parse(await parseJsonBody(request));
    if (body.secretKey && (await isTurnstileSecretRejected(body.secretKey))) {
      return jsonError("Cloudflare 说这个 Secret Key 不对：请到 Cloudflare 的 Turnstile 页面复制 Secret Key（不是 Site Key）");
    }
    const cfg = await updateTurnstileConfig(body);
    return jsonOk({ config: serialize(cfg) });
  } catch (error) {
    return jsonError(getErrorMessage(error), 400);
  }
}
