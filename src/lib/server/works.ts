import "server-only";

import { Prisma, ShowcaseStatus } from "@prisma/client";

import { db } from "@/lib/db";
import { publicWorkWhere, visibleWorkWhere } from "@/lib/server/public-work";
import { imageAvailabilityInclude } from "@/lib/storage/image-availability";
import { galleryWorkInclude, publicGalleryWhere, reviewableGalleryWhere, serializeAdminGalleryWork, serializeFeaturedGalleryWork, serializeGalleryWork } from "@/lib/server/gallery-work-data";
import {
  serializeAdminWork,
  serializeFeaturedVideo,
  serializeFeaturedWork,
  serializeWork,
  type FeaturedVideoRecord,
  type FeaturedWorkRecord,
  type SerializedWork,
} from "@/lib/prisma-mappers";

const FEATURED_WORKS_PAGE_SIZE = 24;
const USER_WORKS_PAGE_SIZE = 24;
const USER_WORKS_MAX_LIMIT = 60;

const workBaseInclude = Prisma.validator<Prisma.GenerationImageInclude>()({
  ...imageAvailabilityInclude,
  job: {
    select: {
      createdAt: true,
      id: true,
      model: true,
      negativePrompt: true,
      prompt: true,
      size: true,
      status: true,
      user: {
        select: {
          nickname: true,
        },
      },
      userId: true,
    },
  },
  reviewedBy: {
    select: {
      id: true,
    },
  },
});

const workAdminInclude = Prisma.validator<Prisma.GenerationImageInclude>()({
  ...imageAvailabilityInclude,
  job: {
    select: {
      createdAt: true,
      id: true,
      model: true,
      negativePrompt: true,
      prompt: true,
      size: true,
      status: true,
      user: {
        select: {
          email: true,
          id: true,
          nickname: true,
        },
      },
      userId: true,
    },
  },
  reviewedBy: {
    select: {
      email: true,
      id: true,
    },
  },
});

// 用户作品分页：cursor 复合排序 (createdAt desc, id desc) 保证稳定翻页
type UserWorksCursor = {
  createdAt: string;
  id: string;
};

function encodeUserWorksCursor(cursor: UserWorksCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeUserWorksCursor(cursor?: string | null): UserWorksCursor | null {
  if (!cursor) {
    return null;
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<UserWorksCursor>;
    if (
      typeof decoded.createdAt !== "string" ||
      typeof decoded.id !== "string"
    ) {
      return null;
    }
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    return null;
  }
}

type ListUserWorksPageOptions = {
  userId: string;
  cursor?: string | null;
  limit?: number;
};

export type UserWorksPage = {
  hasMore: boolean;
  items: SerializedWork[];
  nextCursor: string | null;
};

export async function listUserWorksPage({
  userId,
  cursor,
  limit,
}: ListUserWorksPageOptions): Promise<UserWorksPage> {
  const take = Math.min(
    Math.max(limit ?? USER_WORKS_PAGE_SIZE, 1),
    USER_WORKS_MAX_LIMIT,
  );
  const decoded = decodeUserWorksCursor(cursor);
  const cursorDate = decoded ? new Date(decoded.createdAt) : null;

  const works = await db.generationImage.findMany({
    where: {
      job: { userId },
      ...(decoded && cursorDate
        ? {
            OR: [
              { createdAt: { lt: cursorDate } },
              {
                createdAt: cursorDate,
                id: { lt: decoded.id },
              },
            ],
          }
        : {}),
    },
    include: workBaseInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
  });

  const uploads = await db.galleryWork.findMany({
    where: { userId, ...(decoded && cursorDate ? { OR: [
      { createdAt: { lt: cursorDate } }, { createdAt: cursorDate, id: { lt: decoded.id } },
    ] } : {}) }, include: galleryWorkInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1,
  });
  const combined = [...works.map(serializeWork), ...uploads.map(serializeGalleryWork)]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const hasMore = combined.length > take;
  const items = combined.slice(0, take);
  const last = items.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeUserWorksCursor({
          createdAt: last.createdAt,
          id: last.id,
        })
      : null;

  return { hasMore, items, nextCursor };
}

export type UserWorksCounts = {
  featured: number;
  pending: number;
  total: number;
};

export async function getUserWorksCounts(
  userId: string,
): Promise<UserWorksCounts> {
  const [total, statusGroups] = await Promise.all([
    db.generationImage.count({ where: { job: { userId } } }),
    db.generationImage.groupBy({
      by: ["showcaseStatus"],
      where: { job: { userId } },
      _count: { _all: true },
    }),
  ]);

  const counts: UserWorksCounts = { featured: 0, pending: 0, total };
  const uploads = await db.galleryWork.groupBy({ by: ["showcaseStatus"], where: { userId }, _count: { _all: true } });
  for (const group of uploads) {
    counts.total += group._count._all;
    if (group.showcaseStatus === "PENDING") counts.pending += group._count._all;
    if (group.showcaseStatus === "FEATURED") counts.featured += group._count._all;
  }
  for (const group of statusGroups) {
    if (group.showcaseStatus === ShowcaseStatus.PENDING) {
      counts.pending += group._count._all;
    } else if (group.showcaseStatus === ShowcaseStatus.FEATURED) {
      counts.featured += group._count._all;
    }
  }
  return counts;
}

export async function listFeaturedWorks(take = 6) {
  const page = await listFeaturedWorksPage({ limit: take });
  return page.items;
}

type FeaturedWorksCursor = {
  featuredAt: string;
  id: string;
};

type ListFeaturedWorksPageOptions = {
  cursor?: string | null;
  limit?: number;
  viewerId?: string | null;
};

export type FeaturedWorksPage = {
  hasMore: boolean;
  items: ReturnType<typeof serializeFeaturedWork>[];
  nextCursor: string | null;
};

function encodeFeaturedWorksCursor(cursor: FeaturedWorksCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeFeaturedWorksCursor(cursor?: string | null) {
  if (!cursor) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<FeaturedWorksCursor>;
    if (typeof decoded.featuredAt !== "string" || typeof decoded.id !== "string") {
      return null;
    }
    return decoded as FeaturedWorksCursor;
  } catch {
    return null;
  }
}

export async function listFeaturedWorksPage(
  options: ListFeaturedWorksPageOptions = {},
): Promise<FeaturedWorksPage> {
  const limit = Math.min(
    Math.max(options.limit ?? FEATURED_WORKS_PAGE_SIZE, 1),
    FEATURED_WORKS_PAGE_SIZE,
  );
  const cursor = decodeFeaturedWorksCursor(options.cursor);
  const cursorFeaturedAt = cursor ? new Date(cursor.featuredAt) : null;
  const hasValidCursor =
    cursor && cursorFeaturedAt && !Number.isNaN(cursorFeaturedAt.getTime());

  const works = await db.generationImage.findMany({
    where: {
      ...publicWorkWhere,
      featuredAt: {
        not: null,
      },
      ...(hasValidCursor
        ? {
            OR: [
              { featuredAt: { lt: cursorFeaturedAt } },
              {
                featuredAt: cursorFeaturedAt,
                id: { lt: cursor.id },
              },
            ],
          }
        : {}),
    },
    include: {
      ...workBaseInclude,
      _count: {
        select: {
          likes: true,
        },
      },
      job: {
        select: {
          createdAt: true,
          id: true,
          model: true,
          negativePrompt: true,
          prompt: true,
          size: true,
          status: true,
          user: {
            select: {
              avatarUrl: true,
              id: true,
              nickname: true,
            },
          },
          userId: true,
        },
      },
      ...(options.viewerId
        ? {
            likes: {
              where: {
                userId: options.viewerId,
              },
              select: {
                userId: true,
              },
              take: 1,
            },
          }
        : {}),
    },
    orderBy: [
      {
        featuredAt: "desc",
      },
      {
        id: "desc",
      },
    ],
    take: limit + 1,
  });

  const uploads = await db.galleryWork.findMany({
    where: { ...publicGalleryWhere, featuredAt: { not: null }, ...(hasValidCursor ? { OR: [
      { featuredAt: { lt: cursorFeaturedAt } }, { featuredAt: cursorFeaturedAt, id: { lt: cursor.id } },
    ] } : {}) },
    include: { ...galleryWorkInclude, _count: { select: { likes: true } },
      ...(options.viewerId ? { likes: { where: { userId: options.viewerId }, select: { userId: true }, take: 1 } } : {}) },
    orderBy: [{ featuredAt: "desc" }, { id: "desc" }], take: limit + 1,
  });
  const combined = [
    ...works.map((work) => serializeFeaturedWork(work as unknown as FeaturedWorkRecord)),
    ...uploads.map(serializeFeaturedGalleryWork),
  ].sort((a, b) => (b.featuredAt ?? "").localeCompare(a.featuredAt ?? "") || b.id.localeCompare(a.id));
  const hasMore = combined.length > limit;
  const pageItems = combined.slice(0, limit);
  const last = pageItems.at(-1);
  const nextCursor =
    hasMore && last && last.featuredAt
      ? encodeFeaturedWorksCursor({
          featuredAt: last.featuredAt,
          id: last.id,
        })
      : null;

  return {
    hasMore,
    items: pageItems,
    nextCursor,
  };
}

export async function listAdminWorks(take = 120) {
  const works = await db.generationImage.findMany({
    where: {
      showcaseStatus: {
        in: [
          ShowcaseStatus.PENDING,
          ShowcaseStatus.TAKEDOWN_PENDING,
          ShowcaseStatus.FEATURED,
        ],
      },
    },
    include: workAdminInclude,
    orderBy: [
      {
        featuredAt: "desc",
      },
      {
        submittedAt: "desc",
      },
      {
        createdAt: "desc",
      },
    ],
    take,
  });

  return works.map(serializeAdminWork);
}

export async function getWorkById(id: string, viewerId?: string | null) {
  if (id.startsWith("gallery_")) {
    const upload = await db.galleryWork.findUnique({
      where: { id, ...(viewerId ? { OR: [publicGalleryWhere, { userId: viewerId }] } : publicGalleryWhere) },
      include: galleryWorkInclude,
    });
    return upload ? serializeGalleryWork(upload) : null;
  }
  const work = await db.generationImage.findUnique({
    where: { id, ...visibleWorkWhere(viewerId) },
    include: workBaseInclude,
  });

  return work ? serializeWork(work) : null;
}

export async function getAdminWorkById(id: string) {
  if (id.startsWith("gallery_")) {
    const upload = await db.galleryWork.findUnique({ where: { id }, include: galleryWorkInclude });
    return upload ? serializeAdminGalleryWork(upload) : null;
  }
  const work = await db.generationImage.findUnique({
    where: { id },
    include: workAdminInclude,
  });

  return work ? serializeAdminWork(work) : null;
}

export async function getWorkMutationTarget(id: string) {
  return db.generationImage.findUnique({
    where: { id },
    select: {
      ...imageAvailabilityInclude,
      featuredAt: true,
      job: {
        select: {
          userId: true,
        },
      },
      showcaseStatus: true,
      submittedAt: true,
    },
  });
}

const videoFeaturedInclude = {
  job: {
    select: {
      createdAt: true,
      id: true,
      model: true,
      negativePrompt: true,
      prompt: true,
      size: true,
      status: true,
      user: {
        select: {
          avatarUrl: true,
          id: true,
          nickname: true,
        },
      },
      userId: true,
    },
  },
  _count: {
    select: {
      likes: true,
    },
  },
};

export type FeaturedVideosPage = {
  hasMore: boolean;
  items: ReturnType<typeof serializeFeaturedVideo>[];
  nextCursor: string | null;
};

export async function listFeaturedVideosPage(
  options: { cursor?: string | null; limit?: number; viewerId?: string | null } = {},
): Promise<FeaturedVideosPage> {
  const limit = Math.min(Math.max(options.limit ?? FEATURED_WORKS_PAGE_SIZE, 1), FEATURED_WORKS_PAGE_SIZE);
  const cursor = decodeFeaturedWorksCursor(options.cursor);
  const cursorFeaturedAt = cursor ? new Date(cursor.featuredAt) : null;
  const hasValidCursor = cursor && cursorFeaturedAt && !Number.isNaN(cursorFeaturedAt.getTime());

  const videos = await db.generatedVideo.findMany({
    where: {
      ...publicWorkWhere,
      featuredAt: { not: null },
      ...(hasValidCursor
        ? {
            OR: [
              { featuredAt: { lt: cursorFeaturedAt } },
              { featuredAt: cursorFeaturedAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    include: {
      ...videoFeaturedInclude,
      ...(options.viewerId
        ? { likes: { where: { userId: options.viewerId }, select: { userId: true }, take: 1 } }
        : {}),
    },
    orderBy: [{ featuredAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = videos.length > limit;
  const pageItems = hasMore ? videos.slice(0, limit) : videos;
  const last = pageItems[pageItems.length - 1];
  const nextCursor =
    hasMore && last && last.featuredAt
      ? encodeFeaturedWorksCursor({ featuredAt: last.featuredAt.toISOString(), id: last.id })
      : null;

  return {
    hasMore,
    items: pageItems.map((v) => serializeFeaturedVideo(v as unknown as FeaturedVideoRecord)),
    nextCursor,
  };
}

export async function getVideoMutationTarget(id: string) {
  return db.generatedVideo.findUnique({
    where: { id },
    select: {
      featuredAt: true,
      job: { select: { userId: true } },
      showcaseStatus: true,
      submittedAt: true,
    },
  });
}

export type AdminReviewMediaFilter = "all" | "image" | "video";

export type AdminReviewCounts = {
  featured: number;
  pending: number;
  takedownPending: number;
};

export async function getAdminReviewCounts(): Promise<AdminReviewCounts> {
  const uploaded = await db.galleryWork.groupBy({ by: ["showcaseStatus"], where: reviewableGalleryWhere(), _count: { _all: true } });
  const uploadCount = (status: ShowcaseStatus) => uploaded.find((group) => group.showcaseStatus === status)?._count._all ?? 0;
  const countImg =
    typeof db.generationImage?.count === "function"
      ? (status: ShowcaseStatus) =>
          db.generationImage.count({ where: { showcaseStatus: status } })
      : async () => 0;
  const countVid =
    typeof db.generatedVideo?.count === "function"
      ? (status: ShowcaseStatus) =>
          db.generatedVideo.count({ where: { showcaseStatus: status } })
      : async () => 0;

  const [
    imgPending,
    vidPending,
    imgTakedown,
    vidTakedown,
    imgFeatured,
    vidFeatured,
  ] = await Promise.all([
    countImg(ShowcaseStatus.PENDING),
    countVid(ShowcaseStatus.PENDING),
    countImg(ShowcaseStatus.TAKEDOWN_PENDING),
    countVid(ShowcaseStatus.TAKEDOWN_PENDING),
    countImg(ShowcaseStatus.FEATURED),
    countVid(ShowcaseStatus.FEATURED),
  ]);

  return {
    featured: imgFeatured + vidFeatured + uploadCount("FEATURED"),
    pending: imgPending + vidPending + uploadCount("PENDING"),
    takedownPending: imgTakedown + vidTakedown + uploadCount("TAKEDOWN_PENDING"),
  };
}

const videoAdminInclude = Prisma.validator<Prisma.GeneratedVideoInclude>()({
  job: {
    select: {
      createdAt: true,
      id: true,
      model: true,
      negativePrompt: true,
      prompt: true,
      size: true,
      status: true,
      user: {
        select: {
          email: true,
          id: true,
          nickname: true,
        },
      },
      userId: true,
    },
  },
  reviewedBy: {
    select: {
      email: true,
      id: true,
    },
  },
});

export type SerializedAdminReviewItem = ReturnType<typeof serializeAdminWork> & {
  durationSeconds?: number | null;
  mediaType?: "image" | "video";
  posterUrl?: string | null;
};

export async function listAdminReviewPage(options: {
  mediaType?: AdminReviewMediaFilter;
  page?: number;
  pageSize?: number;
  q?: string;
  status: ShowcaseStatus;
}): Promise<{
  items: SerializedAdminReviewItem[];
  totalCount: number;
}> {
  const mediaType = options.mediaType ?? "all";
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(Math.max(options.pageSize ?? 20, 1), 60);
  const q = (options.q ?? "").trim();

  const jobSearchWhere: Prisma.GenerationJobWhereInput | undefined = q
    ? {
        OR: [
          { prompt: { contains: q, mode: "insensitive" } },
          { model: { contains: q, mode: "insensitive" } },
          {
            user: {
              is: {
                OR: [
                  { email: { contains: q, mode: "insensitive" } },
                  { nickname: { contains: q, mode: "insensitive" } },
                ],
              },
            },
          },
        ],
      }
    : undefined;

  const imageWhere: Prisma.GenerationImageWhereInput = {
    showcaseStatus: options.status,
    ...(jobSearchWhere ? { job: { is: jobSearchWhere } } : {}),
  };

  const videoWhere: Prisma.GeneratedVideoWhereInput = {
    showcaseStatus: options.status,
    ...(jobSearchWhere ? { job: { is: jobSearchWhere } } : {}),
  };

  const canCountImage = typeof db.generationImage?.count === "function";
  const canQueryVideo = typeof db.generatedVideo?.findMany === "function";
  const canCountVideo = typeof db.generatedVideo?.count === "function";

  if (mediaType === "video") {
    const rows = canQueryVideo
      ? await db.generatedVideo.findMany({
          include: videoAdminInclude,
          orderBy: [
            { submittedAt: "desc" },
            { featuredAt: "desc" },
            { createdAt: "desc" },
          ],
          skip: (page - 1) * pageSize,
          take: pageSize,
          where: videoWhere,
        })
      : [];
    const totalCount = canCountVideo
      ? await db.generatedVideo.count({ where: videoWhere })
      : rows.length;
    return {
      items: rows.map((row) => ({
        author: row.job.user,
        authorNickname: row.job.user.nickname ?? null,
        availability: "available" as const,
        createdAt: row.createdAt.toISOString(),
        durationSeconds: row.durationSeconds,
        featuredAt: row.featuredAt?.toISOString() ?? null,
        generationCreatedAt: row.job.createdAt.toISOString(),
        generationStatus:
          row.job.status === "SUCCEEDED"
            ? ("succeeded" as const)
            : row.job.status === "FAILED"
              ? ("failed" as const)
              : ("pending" as const),
        id: row.id,
        jobId: row.jobId,
        mediaType: "video" as const,
        model: row.job.model,
        negativePrompt: row.job.negativePrompt,
        ownerId: row.job.userId,
        posterUrl: row.posterUrl,
        prompt: row.job.prompt,
        publicAuthorName: row.publicAuthorName,
        reviewNote: row.reviewNote,
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
        reviewedById: row.reviewedById,
        reviewer: row.reviewedBy
          ? { email: row.reviewedBy.email, id: row.reviewedBy.id }
          : null,
        showPromptPublic: row.showPromptPublic,
        showcaseStatus: row.showcaseStatus,
        size: row.job.size,
        submittedAt: row.submittedAt?.toISOString() ?? null,
        url: row.url,
      })),
      totalCount,
    };
  }

  // mediaType === "all": fetch up to page * pageSize from each and merge-sort accurately
  const windowLimit = page * pageSize;
  const [imgRows, vidRows] = await Promise.all([
    db.generationImage.findMany({
      include: workAdminInclude,
      orderBy: [
        { submittedAt: "desc" },
        { featuredAt: "desc" },
        { createdAt: "desc" },
      ],
      take: windowLimit,
      where: imageWhere,
    }),
    canQueryVideo && mediaType !== "image"
      ? db.generatedVideo.findMany({
          include: videoAdminInclude,
          orderBy: [
            { submittedAt: "desc" },
            { featuredAt: "desc" },
            { createdAt: "desc" },
          ],
          take: windowLimit,
          where: videoWhere,
        })
      : Promise.resolve([]),
  ]);

  const [imgCount, vidCount] = await Promise.all([
    canCountImage
      ? db.generationImage.count({ where: imageWhere })
      : Promise.resolve(imgRows.length),
    canCountVideo && mediaType !== "image"
      ? db.generatedVideo.count({ where: videoWhere })
      : Promise.resolve(vidRows.length),
  ]);

  const mappedImages: SerializedAdminReviewItem[] = imgRows.map(serializeAdminWork);

  const mappedVideos: SerializedAdminReviewItem[] = vidRows.map((row) => ({
    author: row.job.user,
    authorNickname: row.job.user.nickname ?? null,
    availability: "available",
    createdAt: row.createdAt.toISOString(),
    durationSeconds: row.durationSeconds,
    featuredAt: row.featuredAt?.toISOString() ?? null,
    generationCreatedAt: row.job.createdAt.toISOString(),
    generationStatus:
      row.job.status === "SUCCEEDED"
        ? "succeeded"
        : row.job.status === "FAILED"
          ? "failed"
          : "pending",
    id: row.id,
    jobId: row.jobId,
    mediaType: "video",
    model: row.job.model,
    negativePrompt: row.job.negativePrompt,
    ownerId: row.job.userId,
    posterUrl: row.posterUrl,
    prompt: row.job.prompt,
    publicAuthorName: row.publicAuthorName,
    reviewNote: row.reviewNote,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewedById: row.reviewedById,
    reviewer: row.reviewedBy
      ? { email: row.reviewedBy.email, id: row.reviewedBy.id }
      : null,
    showPromptPublic: row.showPromptPublic,
    showcaseStatus: row.showcaseStatus,
    size: row.job.size,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    url: row.url,
  }));

  const galleryWhere: Prisma.GalleryWorkWhereInput = {
    showcaseStatus: options.status,
    AND: [reviewableGalleryWhere(), ...(q ? [{ OR: [
      { prompt: { contains: q, mode: "insensitive" as const } },
      { user: { OR: [{ email: { contains: q, mode: "insensitive" as const } }, { nickname: { contains: q, mode: "insensitive" as const } }] } },
    ] }] : [])],
  };
  const [uploads, uploadCount] = await Promise.all([
    db.galleryWork.findMany({ where: galleryWhere, include: galleryWorkInclude,
      orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: windowLimit }),
    db.galleryWork.count({ where: galleryWhere }),
  ]);
  const combined = [...mappedImages, ...mappedVideos, ...uploads.map(serializeAdminGalleryWork)].sort((a, b) => {
    const timeA = Date.parse(a.submittedAt ?? a.featuredAt ?? a.createdAt);
    const timeB = Date.parse(b.submittedAt ?? b.featuredAt ?? b.createdAt);
    return timeB - timeA || b.id.localeCompare(a.id);
  });

  return {
    items: combined.slice((page - 1) * pageSize, page * pageSize),
    totalCount: imgCount + vidCount + uploadCount,
  };
}
