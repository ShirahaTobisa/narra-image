import { requireAdminRecord } from "@/lib/server/current-user";
import { jsonError, jsonOk, getErrorMessage, parseJsonBody } from "@/lib/server/http";
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

    // 限定服务器只对 Discord 有意义；Discord 的服务器 ID 是一串数字
    const allowedGuildId =
      body.type === "discord" && typeof body.allowedGuildId === "string"
        ? body.allowedGuildId.trim()
        : undefined;
    if (allowedGuildId && !/^\d{15,25}$/.test(allowedGuildId)) {
      return jsonError("服务器 ID 应为一串数字（在 Discord 开发者模式下右键服务器复制）");
    }

    await upsertOAuthProvider({
      allowedGuildId,
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
