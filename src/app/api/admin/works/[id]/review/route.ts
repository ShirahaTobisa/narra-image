import { revalidateTag } from "next/cache";

import { db } from "@/lib/db";
import { getAdminWorkById, getVideoMutationTarget, getWorkMutationTarget } from "@/lib/server/works";
import { requireAdminRecord } from "@/lib/server/current-user";
import { getErrorMessage, jsonError, jsonOk, parseJsonBody } from "@/lib/server/http";
import { applyAdminWorkReview } from "@/lib/work-showcase";
import { adminWorkReviewSchema } from "@/lib/validators";
import { GalleryUploadError, reviewGalleryWork } from "@/lib/server/gallery-uploads";

function resolveStatusCode(error: unknown) {
  if (error instanceof GalleryUploadError) return error.status;
  if (error instanceof Error && error.message === "当前状态不允许执行该审核操作") {
    return 409;
  }

  return 400;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireAdminRecord();
    const body = adminWorkReviewSchema.parse(await parseJsonBody(request));
    const { id } = await context.params;

    if (id.startsWith("gallery_")) {
      await reviewGalleryWork({ id, actorId: admin.id, action: body.action,
        submittedAt: body.submittedAt, reviewNote: body.reviewNote });
      revalidateTag("featured-works", { expire: 0 });
      return jsonOk({ work: await getAdminWorkById(id), mediaType: "image" });
    }

    const isVideo = body.mediaType === "video";
    const work = isVideo ? await getVideoMutationTarget(id) : await getWorkMutationTarget(id);
    if (!work) {
      return jsonError("作品不存在", 404);
    }
    if (body.submittedAt !== (work.submittedAt?.toISOString() ?? null)) {
      return jsonError("投稿已变更，请刷新后重新审核", 409);
    }

    const data = applyAdminWorkReview({
      action: body.action,
      currentFeaturedAt: work.featuredAt,
      currentStatus: work.showcaseStatus,
      reviewNote: body.reviewNote,
      reviewerId: admin.id,
    });

    const where = { id, showcaseStatus: work.showcaseStatus, submittedAt: work.submittedAt };
    const updated = isVideo
      ? await db.generatedVideo.updateMany({ where, data })
      : await db.generationImage.updateMany({ where, data });
    if (updated.count !== 1) {
      return jsonError("作品状态已变更，请刷新后重新审核", 409);
    }

    revalidateTag("featured-works", "max");

    const updatedWork = isVideo ? null : await getAdminWorkById(id);

    return jsonOk({
      work: updatedWork,
      mediaType: body.mediaType,
    });
  } catch (error) {
    return jsonError(getErrorMessage(error), resolveStatusCode(error));
  }
}
