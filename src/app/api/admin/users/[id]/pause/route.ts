import { db } from "@/lib/db";
import { requireAdminRecord } from "@/lib/server/current-user";
import { getErrorMessage, jsonError, jsonOk, parseJsonBody } from "@/lib/server/http";

/**
 * 暂停或解除暂停某个用户的站内提交（照常能登录，只是不能用站内渠道出图）。
 * 解除时同时记下时间：这之前被拒的记录不再计入“24 小时满 3 次”，所以自动暂停也一并解除。
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdminRecord();
    const { id } = await context.params;
    const body = (await parseJsonBody(request)) as { paused?: unknown };

    if (typeof body.paused !== "boolean") {
      return jsonError("无效的暂停参数", 400);
    }
    if (!(await db.user.findUnique({ select: { id: true }, where: { id } }))) {
      return jsonError("用户不存在", 404);
    }

    const now = new Date();
    await db.user.update({
      data: body.paused ? { generationPausedAt: now } : { generationPausedAt: null, moderationClearedAt: now },
      where: { id },
    });

    return jsonOk({ user: { id, paused: body.paused } });
  } catch (error) {
    return jsonError(getErrorMessage(error), 400);
  }
}
