import { db } from "@/lib/db";
import { getWorkMutationTarget } from "@/lib/server/works";
import { requireCurrentUserRecord } from "@/lib/server/current-user";
import { getErrorMessage, jsonError, jsonOk } from "@/lib/server/http";
import { reviewGalleryWork } from "@/lib/server/gallery-uploads";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireCurrentUserRecord();
    const { id } = await context.params;

    if (id.startsWith("gallery_")) {
      const upload = await db.galleryWork.findUnique({ where: { id, userId: user.id } });
      if (!upload) return jsonError("作品不存在", 404);
      if (upload.showcaseStatus === "FEATURED" || upload.showcaseStatus === "TAKEDOWN_PENDING") {
        return jsonError("请先申请下架，审核后再移除记录", 409);
      }
      if (upload.showcaseStatus === "PENDING") {
        await reviewGalleryWork({ id, actorId: user.id, action: "withdraw", submittedAt: upload.submittedAt.toISOString() });
      }
      await db.galleryWork.deleteMany({ where: { id, userId: user.id, showcaseStatus: "PRIVATE" } });
      return jsonOk({ id });
    }

    const work = await getWorkMutationTarget(id);
    if (!work || work.job.userId !== user.id) {
      return jsonError("作品不存在", 404);
    }

    await db.generationImage.delete({ where: { id } });

    return jsonOk({ id });
  } catch (error) {
    return jsonError(getErrorMessage(error), 400);
  }
}
