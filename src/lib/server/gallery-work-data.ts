import "server-only";

import { Prisma } from "@prisma/client";
import { imageAvailabilityInclude } from "@/lib/storage/image-availability";
import { presentGenerationImage } from "@/lib/storage/image-presentation";
import type { SerializedAdminWork, SerializedFeaturedWork, SerializedWork } from "@/lib/prisma-mappers";

export const galleryWorkInclude = Prisma.validator<Prisma.GalleryWorkInclude>()({
  ...imageAvailabilityInclude,
  user: { select: { id: true, nickname: true, email: true } },
  reviewedBy: { select: { id: true, email: true } },
});
type GalleryRecord = Prisma.GalleryWorkGetPayload<{ include: typeof galleryWorkInclude }>;

export const publicGalleryWhere = {
  showcaseStatus: "FEATURED" as const, user: { bannedAt: null },
  mediaAsset: { state: "AVAILABLE", expiresAt: null },
};

/** A pending upload whose image has run out can no longer be approved, so reviewers do not see it. */
export function reviewableGalleryWhere(): Prisma.GalleryWorkWhereInput {
  return { OR: [{ showcaseStatus: { not: "PENDING" } }, { mediaAsset: { state: "AVAILABLE", expiresAt: { gt: new Date() } } }] };
}

export function serializeGalleryWork(work: GalleryRecord): SerializedWork {
  const presentation = presentGenerationImage({ ...work, url: "" });
  return {
    ...presentation, source: "uploaded", authorNickname: work.user.nickname,
    createdAt: work.createdAt.toISOString(), featuredAt: work.featuredAt?.toISOString() ?? null,
    generationCreatedAt: null, generationStatus: null, jobId: null, model: null,
    id: work.id, ownerId: work.userId, prompt: work.prompt ?? "", negativePrompt: work.negativePrompt,
    publicAuthorName: work.publicAuthorName, reviewNote: work.reviewNote,
    reviewedAt: work.reviewedAt?.toISOString() ?? null, reviewedById: work.reviewedById,
    reviewer: work.reviewedBy, showcaseStatus: work.showcaseStatus, showPromptPublic: work.showPromptPublic,
    size: work.width && work.height ? `${work.width}x${work.height}` : "", submittedAt: work.submittedAt.toISOString(),
    expiresAt: work.mediaAsset?.expiresAt?.toISOString() ?? null,
  };
}

export function serializeAdminGalleryWork(work: GalleryRecord): SerializedAdminWork {
  return { ...serializeGalleryWork(work), author: { id: work.user.id, email: work.user.email } };
}

export function serializeFeaturedGalleryWork(work: GalleryRecord & { _count?: { likes: number }; likes?: { userId: string }[] }): SerializedFeaturedWork {
  const display = serializeGalleryWork(work);
  return { availability: display.availability, authorAvatar: null, authorName: work.publicAuthorName || "匿名创作者",
    featuredAt: display.featuredAt, id: work.id, image: display.url, likeCount: work._count?.likes ?? 0,
    likedByMe: Boolean(work.likes?.length), prompt: work.showPromptPublic ? work.prompt ?? "" : "作者未公开提示词",
    showPromptPublic: work.showPromptPublic, size: display.size, title: "用户上传" };
}
