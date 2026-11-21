import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ images: vi.fn(), videos: vi.fn(), image: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  galleryWork: { findMany: async () => [] },
  generationImage: { findMany: mocks.images, findUnique: mocks.image },
  generatedVideo: { findMany: mocks.videos },
} }));

import { getWorkById, listFeaturedVideosPage, listFeaturedWorksPage } from "@/lib/server/works";
import { createPrivacyWork } from "./helpers/work-privacy-fixtures";

type VisibilityWhere = {
  id?: string;
  showcaseStatus?: string;
  job?: { userId?: string; user?: { bannedAt: null } };
  OR?: VisibilityWhere[];
};
function record(id: string, bannedAt: Date | null, showcaseStatus: "PRIVATE" | "FEATURED" = "FEATURED") {
  const original = createPrivacyWork({ id, showcaseStatus });
  return { ...original, durationSeconds: null, posterUrl: null, job: { ...original.job,
    userId: `owner-${id}`, user: { ...original.job.user, id: `owner-${id}`, bannedAt },
  } };
}
// Only the relevant Prisma predicates are simulated here; this is a query-contract test, not a real database test.
function matches(where: VisibilityWhere, row: ReturnType<typeof record>): boolean {
  return (!where.id || where.id === row.id)
    && (!where.showcaseStatus || where.showcaseStatus === row.showcaseStatus)
    && (!where.job?.userId || where.job.userId === row.job.userId)
    && (!where.job?.user || row.job.user.bannedAt === null)
    && (!where.OR || where.OR.some((option) => matches(option, row)));
}

beforeEach(() => vi.resetAllMocks());

describe("封禁作者的公开作品资格", () => {
  it.each(["image", "video"])("%s 精选排除封禁作者，解封后恢复原批准作品", async (mediaType) => {
    const banned = record("banned", new Date());
    const visible = record("visible", null);
    const hidden = record("private", null, "PRIVATE");
    const query = mediaType === "image" ? mocks.images : mocks.videos;
    query.mockImplementation(async ({ where }: { where: VisibilityWhere }) => [banned, visible, hidden].filter((row) => matches(where, row)));
    const list = mediaType === "image" ? listFeaturedWorksPage : listFeaturedVideosPage;
    expect((await list()).items.map((item) => item.id)).toEqual(["visible"]);
    expect(query.mock.calls[0][0].where).toMatchObject({ showcaseStatus: "FEATURED", job: { user: { bannedAt: null } } });
    banned.job.user.bannedAt = null;
    expect((await list()).items.map((item) => item.id).sort()).toEqual(["banned", "visible"]);
    expect(banned.showcaseStatus).toBe("FEATURED");
  });

  it("详情拒绝封禁作者的已批准作品，仍保留本人私有详情", async () => {
    const banned = record("banned", new Date());
    const hidden = record("private", null, "PRIVATE");
    mocks.image.mockImplementation(async ({ where }: { where: VisibilityWhere }) => [banned, hidden].find((row) => matches(where, row)) ?? null);
    expect(await getWorkById("banned")).toBeNull();
    expect(await getWorkById("private", "someone-else")).toBeNull();
    expect(await getWorkById("private", hidden.job.userId)).toMatchObject({ id: "private", showcaseStatus: "PRIVATE" });
    banned.job.user.bannedAt = null;
    expect(await getWorkById("banned")).toMatchObject({ id: "banned", showcaseStatus: "FEATURED" });
  });
});
