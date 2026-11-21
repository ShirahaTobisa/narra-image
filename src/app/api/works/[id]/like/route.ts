import { ShowcaseStatus } from "@prisma/client";

import { db } from "@/lib/db";
import { getCurrentUserRecord } from "@/lib/server/current-user";
import { publicWorkWhere } from "@/lib/server/public-work";
import { publicGalleryWhere } from "@/lib/server/gallery-work-data";
import { getErrorMessage, jsonError, jsonOk } from "@/lib/server/http";

export async function PUT(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUserRecord();
    if (!user) {
      return jsonError("请先登录", 401);
    }

    const { id } = await context.params;
    const { searchParams } = new URL(_request.url);
    const isVideo = searchParams.get("mediaType") === "video";

    if (id.startsWith("gallery_")) {
      const result = await db.$transaction(async (tx) => {
        const work = await tx.galleryWork.findUnique({ where: { id, ...publicGalleryWhere }, select: { id: true } });
        if (!work) return null;
        const where = { galleryWorkId_userId: { galleryWorkId: id, userId: user.id } };
        const existing = await tx.workLike.findUnique({ where });
        if (existing) await tx.workLike.delete({ where });
        else await tx.workLike.create({ data: { galleryWorkId: id, userId: user.id } });
        return { liked: !existing, likeCount: await tx.workLike.count({ where: { galleryWorkId: id } }) };
      });
      return result ? jsonOk(result) : jsonError("作品未公开，暂不能点赞", 404);
    }

    if (isVideo) {
      const video = await db.generatedVideo.findUnique({
        where: { id, ...publicWorkWhere },
        select: { id: true, showcaseStatus: true },
      });
      if (!video || video.showcaseStatus !== ShowcaseStatus.FEATURED) {
        return jsonError("作品未公开，暂不能点赞", 404);
      }

      const result = await db.$transaction(async (tx) => {
        const existing = await tx.workLike.findUnique({
          where: { videoId_userId: { userId: user.id, videoId: id } },
        });
        const liked = !existing;
        if (existing) {
          await tx.workLike.delete({
            where: { videoId_userId: { userId: user.id, videoId: id } },
          });
        } else {
          await tx.workLike.create({ data: { userId: user.id, videoId: id } });
        }
        const likeCount = await tx.workLike.count({ where: { videoId: id } });
        return { likeCount, liked };
      });

      return jsonOk(result);
    }

    const work = await db.generationImage.findUnique({
      where: { id, ...publicWorkWhere },
      select: {
        id: true,
        showcaseStatus: true,
      },
    });

    if (!work || work.showcaseStatus !== ShowcaseStatus.FEATURED) {
      return jsonError("作品未公开，暂不能点赞", 404);
    }

    const result = await db.$transaction(async (tx) => {
      const existing = await tx.workLike.findUnique({
        where: {
          workId_userId: {
            userId: user.id,
            workId: id,
          },
        },
      });

      const liked = !existing;

      if (existing) {
        await tx.workLike.delete({
          where: {
            workId_userId: {
              userId: user.id,
              workId: id,
            },
          },
        });
      } else {
        await tx.workLike.create({
          data: {
            userId: user.id,
            workId: id,
          },
        });
      }

      const likeCount = await tx.workLike.count({
        where: {
          workId: id,
        },
      });

      return {
        likeCount,
        liked,
      };
    });

    return jsonOk(result);
  } catch (error) {
    return jsonError(getErrorMessage(error), 400);
  }
}
