import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ videos: vi.fn(), video: vi.fn(), jobs: vi.fn(), job: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  generatedVideo: { findMany: mocks.videos, findUnique: mocks.video, count: async () => 1 },
  generationImage: { findMany: async () => [], count: async () => 0 },
  galleryWork: { findMany: async () => [], count: async () => 0 },
  generationJob: { findMany: mocks.jobs, findUnique: mocks.job, count: async () => 1 },
  providerChannel: { findUnique: async () => ({ id: "channel_1", name: "H3", slug: "h3" }) },
} }));
vi.mock("@/lib/server/current-user", () => ({
  getCurrentUserRecord: async () => ({ id: "owner", role: "ADMIN", credits: 10, email: "owner@example.com", uid: 1, nickname: null, avatarUrl: null }),
  requireAdminRecord: async () => ({ id: "owner", role: "ADMIN" }),
}));
vi.mock("@/lib/server/works", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/works")>(),
  getWorkById: async () => null,
  getUserWorksCounts: async () => ({ total: 0, pending: 0, featured: 0 }),
  listUserWorksPage: async () => ({ items: [], hasMore: false, nextCursor: null }),
}));
vi.mock("@/lib/generation/job-refund", () => ({ failStalePendingGenerationJobs: async () => {} }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ APP_URL: "https://narra.example" }) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); }, redirect: () => { throw new Error("redirect"); }, useRouter: () => ({ refresh() {} }) }));

import { serializeFeaturedVideo, serializeGeneration } from "@/lib/prisma-mappers";
import { presentGeneratedVideo } from "@/lib/storage/h3-video";
import { listAdminReviewPage, listFeaturedVideosPage } from "@/lib/server/works";
import WorksPage from "@/app/works/page";
import WorkDetailPage from "@/app/works/[id]/page";
import AdminGenerationsPage from "@/app/admin/generations/page";
import { GET as diagnostic } from "@/app/api/admin/generations/[id]/route";

const source = "https://h3.coolhs.com/api/v1/jobs/42/video";
const poster = source.replace(/video$/, "poster");
const privateError = `${source} secret-channel-key secret-cdn-token`;
const date = new Date("2026-11-28T00:00:00Z");
function videoRecord() {
  return {
    id: "video_1", jobId: "job_1", url: source, posterUrl: poster, mediaStorage: "UPSTREAM", storageKey: null,
    width: 1280, height: 736, durationSeconds: 4, createdAt: date, showcaseStatus: "FEATURED", showPromptPublic: false,
    publicAuthorName: null, submittedAt: date, featuredAt: date, reviewedAt: date, reviewedById: null, reviewNote: null,
    job: { id: "job_1", model: "h3", userId: "owner", prompt: "a scene", negativePrompt: null, size: "1280x736", createdAt: date, status: "SUCCEEDED",
      user: { id: "owner", nickname: null, email: "owner@example.com", avatarUrl: null } },
  };
}
function generation() {
  return {
    ...videoRecord().job, generationType: "TEXT_TO_VIDEO", providerMode: "BUILT_IN", providerBaseUrl: "https://h3.coolhs.com", providerApiKeyEncrypted: "secret-channel-key",
    providerChannelId: "channel_1", images: [], videos: [videoRecord()], sourceImageUrls: [], updatedAt: date, completedAt: date,
    startedAt: date, errorMessage: privateError, featuredAt: null, count: 1, creditsSpent: 20,
    attempts: [{ id: "attempt_1", createdAt: date, updatedAt: date, completedAt: date, upstreamSubmittedAt: date, nextRetryAt: null, errorMessage: privateError }],
  };
}
function expectPrivate(output: unknown) {
  const json = JSON.stringify(output);
  expect(json).toContain("/api/videos/video_1/content");
  expect(json).not.toMatch(/h3\.coolhs\.com|secret-channel-key|secret-cdn-token/);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.videos.mockResolvedValue([videoRecord()]);
  mocks.video.mockResolvedValue(videoRecord());
  mocks.jobs.mockResolvedValue([{ ...generation(), attempts: undefined }]);
  mocks.job.mockResolvedValue(generation());
});

describe("H3 media output boundaries", () => {
  it("projects personal generation history, featured videos, and poster URLs without mutating records", () => {
    const row = videoRecord();
    const personal = serializeGeneration(generation() as never);
    const featured = serializeFeaturedVideo(row as never);
    expectPrivate(personal);
    expectPrivate(featured);
    expect(personal.videos[0]).toMatchObject({ url: "/api/videos/video_1/content", posterUrl: "/api/videos/video_1/content?variant=poster" });
    expect(featured.videoUrl).toBe("/api/videos/video_1/content");
    expect(row.url).toBe(source);
    expect(row.posterUrl).toBe(poster);
  });

  it("keeps normal stored videos readable and hides unexpected H3 media sources by model", () => {
    const legacy = { id: "legacy", url: "https://storage.example/video.mp4", posterUrl: null };
    expect(presentGeneratedVideo(legacy)).toEqual({ url: legacy.url, posterUrl: null });
    expect(presentGeneratedVideo(legacy, "h3")).toEqual({ url: "/api/videos/legacy/content", posterUrl: null });
    expect(presentGeneratedVideo({ ...legacy, url: source })).toEqual({ url: "/api/videos/legacy/content", posterUrl: null });
  });

  it.each(["video", "all"] as const)("projects the actual admin %s review response", async (mediaType) => {
    expectPrivate(await listAdminReviewPage({ status: "FEATURED", mediaType }));
  });

  it("projects the actual featured response", async () => {
    expectPrivate(await listFeaturedVideosPage());
  });

  it("projects personal works and public work detail page props", async () => {
    expectPrivate(await WorksPage());
    expectPrivate(await WorkDetailPage({ params: Promise.resolve({ id: "video_1" }) }));
  });

  it("projects admin list props and diagnostic media and errors", async () => {
    expectPrivate(await AdminGenerationsPage({ searchParams: Promise.resolve({}) }));
    const response = await diagnostic(new Request("https://narra.example/api/admin/generations/job_1"), { params: Promise.resolve({ id: "job_1" }) });
    expect(response.status).toBe(200);
    const output = await response.json();
    expectPrivate(output);
    expect(output.data.job.providerBaseUrl).toBeNull();
    expect(output.data.job.errorMessage).toBe("视频生成失败，请稍后再试");
    expect(output.data.job.attempts[0].errorMessage).toBe("视频生成失败，请稍后再试");
  });
});
