import { requireAdminRecord } from "@/lib/server/current-user";
import { jsonError, jsonOk, getErrorMessage, parseJsonBody } from "@/lib/server/http";
import { parseDiscordGuildIds } from "@/lib/auth/discord-oauth";
import { getAllOAuthProviders, upsertOAuthProvider } from "@/lib/auth/oauth-config";

export async function GET() {
  try {
    await requireAdminRecord();
    const providers = await getAllOAuthProviders();

    return jsonOk({
      providers: providers.map((p) => ({
        ...p,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    return jsonError(getErrorMessage(error), 400);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdminRecord();
    const body = await parseJsonBody<{
      type: string;
      displayName: string;
      clientId: string;
      clientSecret: string;
      isEnabled: boolean;
      allowedGuildId?: string;
    }>(request);

    if (!body.type || !body.clientId) {
      return jsonError("缺少必要参数");
    }

    // 限定服务器只对 Discord 有意义；可以填多个服务器 ID，是其中任意一个的成员就放行
    const guildIds =
      body.type === "discord" && typeof body.allowedGuildId === "string"
        ? parseDiscordGuildIds(body.allowedGuildId)
        : undefined;
    if (guildIds?.some((id) => !/^\d{15,25}$/.test(id))) {
      return jsonError("服务器 ID 应为一串数字，多个用逗号或换行隔开（在 Discord 开发者模式下右键服务器复制）");
    }

    // Discord 应用"基本信息"页的 Public Key 是 64 位十六进制，常被误填成 Client Secret，登录时只会报 invalid_client
    if (body.type === "discord" && /^[0-9a-f]{64}$/i.test(body.clientSecret?.trim() ?? "")) {
      return jsonError("这是 Discord 的 Public Key，不是 Client Secret：请到 Discord 开发者后台的 OAuth2 页面复制 Client Secret");
    }

    await upsertOAuthProvider({
      allowedGuildId: guildIds?.join(","),
      clientId: body.clientId,
      clientSecret: body.clientSecret || "",
      displayName: body.displayName || body.type,
      isEnabled: body.isEnabled ?? false,
      type: body.type,
    });

    const providers = await getAllOAuthProviders();

    return jsonOk({
      providers: providers.map((p) => ({
        ...p,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    return jsonError(getErrorMessage(error), 400);
  }
}
