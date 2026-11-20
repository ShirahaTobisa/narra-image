import { revalidateTag } from "next/cache";

import { db } from "@/lib/db";
import { getVideoMutationTarget, getWorkById, getWorkMutationTarget } from "@/lib/server/works";
import { requireCurrentUserRecord } from "@/lib/server/current-user";
import { getErrorMessage, jsonError, jsonOk, parseJsonBody } from "@/lib/server/http";
import { applyUserShowcaseAction } from "@/lib/work-showcase";
import { workShowcaseUpdateSchema } from "@/lib/validators";
import { isAutoApproveShowcase } from "@/lib/benefits/config";
import { checkGenerationInput, MODERATION_BLOCK_MESSAGE } from "@/lib/moderation/check";

function resolveStatusCode(error: unknown) {
  if (error instanceof Error && error.message === "当前状态不允许执行该操作") {
    return 409;
  }

  return 400;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireCurrentUserRecord();
    const body = workShowcaseUpdateSchema.parse(await parseJsonBody(request));
    const { id } = await context.params;

    const isVideo = body.mediaType === "video";
    const work = isVideo ? await getVideoMutationTarget(id) : await getWorkMutationTarget(id);
    if (!work || work.job.userId !== user.id) {
      return jsonError("作品不存在", 404);
    }

    const data = applyUserShowcaseAction({
      action: body.action,
      currentStatus: work.showcaseStatus,
      showPromptPublic: body.showPromptPublic,
    });
    if (body.action === "submit") {
      const publicAuthorName = body.showAuthorPublic ? user.nickname?.trim() : null;
      if (body.showAuthorPublic && !publicAuthorName) {
        return jsonError("请先设置昵称，或选择匿名投稿", 400);
      }
      if (publicAuthorName) {
        const result = await checkGenerationInput({ builtIn: true, prompt: publicAuthorName, userId: user.id });
        if (!result.allowed) {
          return jsonError(result.message === MODERATION_BLOCK_MESSAGE
            ? "公开署名包含违规内容，请修改昵称或选择匿名投稿"
            : "公开署名暂时无法通过审核，请稍后再试或选择匿名投稿", 400);
        }
      }
      data.publicAuthorName = publicAuthorName ?? null;
      if (await isAutoApproveShowcase()) {
        data.featuredAt = data.submittedAt;
        data.reviewedAt = data.submittedAt;
        data.showcaseStatus = "FEATURED";
      }
    }

    const where = { id, job: { userId: user.id }, showcaseStatus: work.showcaseStatus, submittedAt: work.submittedAt };
    const updated = isVideo
      ? await db.generatedVideo.updateMany({ where, data })
      : await db.generationImage.updateMany({ where, data });
    if (updated.count !== 1) {
      return jsonError("作品状态已变更，请刷新后重试", 409);
    }

    revalidateTag("featured-works", "max");

    const updatedWork = isVideo ? null : await getWorkById(id, user.id);

    return jsonOk({
      work: updatedWork,
      mediaType: body.mediaType,
    });
  } catch (error) {
    return jsonError(getErrorMessage(error), resolveStatusCode(error));
  }
}

