// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(), moderation: vi.fn(), prepare: vi.fn(), complete: vi.fn(), abandon: vi.fn(), review: vi.fn(),
  gallery: { findUnique: vi.fn(), upsert: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  user: { findFirst: vi.fn() }, transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { galleryWork: mocks.gallery, user: mocks.user, $transaction: mocks.transaction } }));
vi.mock("@/lib/server/current-user", () => ({ getCurrentUserRecord: mocks.currentUser }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ APP_URL: "https://draw.example.com" }) }));
vi.mock("@/lib/moderation/check", () => ({ checkGenerationInput: mocks.moderation }));
vi.mock("@/lib/storage/managed-image-storage", () => ({ prepareManagedImageWrite: mocks.prepare, completeManagedImageWrite: mocks.complete, abandonPreparedImageWrite: mocks.abandon }));
vi.mock("@/lib/storage/image-repository", () => ({ ImageRepository: class { reviewGalleryWork = mocks.review; } }));

import { POST } from "@/app/api/me/gallery-uploads/route";
import { assertGalleryUploadRateLimit, readGalleryUpload, reviewGalleryWork, submitGalleryUpload } from "@/lib/server/gallery-uploads";
import { serializeGalleryWork, serializeFeaturedGalleryWork } from "@/lib/server/gallery-work-data";
import { serializePublicWorkDetail } from "@/lib/prisma-mappers";
import { ImageStorageError } from "@/lib/storage/image-contract";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDAAAAAAASUVORK5CYII=", "base64");
const requestKey = "39c28978-9597-4dc4-8154-be6e41ed4fa9";
const user = { id: "u1", nickname: "  Saved name  " };
const input = { requestKey, bytes: png, mimeType: "image/png", prompt: "a landscape", negativePrompt: "noise",
  showAuthorPublic: "false" as const, showPromptPublic: "false" as const };
const asset = { id: "00000000-0000-4000-8000-000000000001", state: "AVAILABLE", activeObjectId: "object",
  publicToken: "a".repeat(64), purpose: "GALLERY_UPLOAD", expiresAt: new Date(Date.now() + 86_400_000) };
function record(data: Record<string, unknown> = {}) {
  return { id: "gallery_one", userId: user.id, mediaAssetId: asset.id, requestKey, payloadHash: "hash", prompt: input.prompt,
    negativePrompt: input.negativePrompt, width: 1, height: 1, showcaseStatus: "PENDING", showPromptPublic: false,
    publicAuthorName: null, submittedAt: new Date(), featuredAt: null, reviewedAt: null, reviewNote: null,
    reviewedById: null, createdAt: new Date(), updatedAt: new Date(), user: { ...user, email: "private@example.com" },
    reviewedBy: null, mediaAsset: asset, ...data };
}
function request(extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new Blob([png], { type: "image/png" }), "image.png");
  form.set("requestKey", requestKey);
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return new Request("https://draw.example.com/api/me/gallery-uploads", { method: "POST", body: form });
}

describe("上传投稿", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("narra.gallery-upload-rate-limit")];
    mocks.currentUser.mockResolvedValue(user);
    mocks.moderation.mockResolvedValue({ allowed: true });
    mocks.user.findFirst.mockResolvedValue(user);
    mocks.prepare.mockResolvedValue({ ticket: { writeGranted: true, asset }, url: "https://draw.example.com/media/gallery-images/" + asset.publicToken });
    mocks.gallery.upsert.mockImplementation(async ({ create }) => record(create));
    mocks.gallery.findUniqueOrThrow.mockImplementation(async () => record(mocks.gallery.upsert.mock.calls[0][0].create));
    mocks.gallery.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async (callback) => callback({ galleryWork: mocks.gallery, $executeRaw: vi.fn() }));
  });

  it("真实路由只将审核后的原图写入独立待审记录，默认匿名", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(mocks.moderation).toHaveBeenCalledOnce();
    expect(mocks.moderation).toHaveBeenCalledWith(expect.objectContaining({ builtIn: true, userId: user.id,
      images: [{ data: png, mimeType: "image/png" }] }));
    expect(mocks.moderation.mock.invocationCallOrder[0]).toBeLessThan(mocks.prepare.mock.invocationCallOrder[0]);
    const created = mocks.gallery.upsert.mock.calls[0][0].create;
    expect(created).toMatchObject({ publicAuthorName: null, showcaseStatus: "PENDING", width: 1, height: 1 });
    expect(created).not.toHaveProperty("jobId");
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ purpose: "GALLERY_UPLOAD", bytes: png, ownerId: user.id }));
    expect((await response.json()).data.work).toMatchObject({ source: "uploaded", jobId: null, model: null });
  });

  it.each(["内容违规", "审核服务不可用", "近24小时已达3次"])("%s 一律不写图片或记录", async (message) => {
    mocks.moderation.mockResolvedValue({ allowed: false, message });
    expect((await POST(request())).status).toBe(400);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.gallery.upsert).not.toHaveBeenCalled();
  });

  it("署名只取服务器昵称，所有文字与原图一次审核", async () => {
    await submitGalleryUpload(user, { ...input, showAuthorPublic: "true" });
    expect(mocks.moderation).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "a landscape\n\nPublic author name:\nSaved name", negativePrompt: "noise",
    }));
    expect(mocks.gallery.upsert.mock.calls[0][0].create.publicAuthorName).toBe("Saved name");
    await expect(submitGalleryUpload({ ...user, nickname: " " }, { ...input, showAuthorPublic: "true" })).rejects.toThrow("选择匿名");
  });

  it("伪造作者、owner、状态或远端地址会被真实解析拒绝", async () => {
    for (const key of ["publicAuthorName", "ownerId", "status", "url", "assetId"]) {
      await expect(readGalleryUpload(request({ [key]: "forged" }))).rejects.toThrow();
    }
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("重放同一请求返回原记录，不再次审核/PUT；变更内容返回冲突", async () => {
    await submitGalleryUpload(user, input);
    mocks.gallery.findUnique.mockResolvedValue(record(mocks.gallery.upsert.mock.calls[0][0].create));
    await submitGalleryUpload(user, input);
    expect(mocks.moderation).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledOnce();
    await expect(submitGalleryUpload(user, { ...input, prompt: "changed" })).rejects.toMatchObject({ status: 409 });
  });

  it("竞争失去写许可不再PUT，未知写入失败不冒充未写入", async () => {
    mocks.prepare.mockResolvedValueOnce({ ticket: { writeGranted: false, asset } });
    await submitGalleryUpload(user, input);
    expect(mocks.complete).not.toHaveBeenCalled();
    mocks.complete.mockRejectedValueOnce(new Error("unknown write"));
    await expect(submitGalleryUpload(user, input)).rejects.toThrow("unknown write");
    expect(mocks.abandon).not.toHaveBeenCalled();
  });

  it("每用户五次上传限流独立于生图，未登录不读取请求体", async () => {
    for (let i = 0; i < 5; i++) assertGalleryUploadRateLimit("u1");
    expect(() => assertGalleryUploadRateLimit("u1")).toThrow("5 次");
    expect(() => assertGalleryUploadRateLimit("u2")).not.toThrow();
    mocks.currentUser.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    expect(mocks.moderation).not.toHaveBeenCalled();
  });

  it("批准需页面所见版本，原子动作冲突返回409", async () => {
    await expect(reviewGalleryWork({ id: "gallery_one", actorId: "admin", action: "approve_feature" })).rejects.toMatchObject({ status: 409 });
    mocks.review.mockRejectedValue(new ImageStorageError("IMAGE_REFERENCE_CONFLICT"));
    await expect(reviewGalleryWork({ id: "gallery_one", actorId: "admin", action: "approve_feature", submittedAt: new Date().toISOString() })).rejects.toMatchObject({ status: 409 });
  });

  it("公开投影只用署名快照，不泄露隐藏提示词、身份或审核资料", () => {
    const work = record({ showcaseStatus: "FEATURED", publicAuthorName: "Frozen", mediaAsset: { ...asset, expiresAt: null } });
    const detail = serializePublicWorkDetail(serializeGalleryWork(work as never));
    expect(detail).toMatchObject({ source: "uploaded", authorNickname: "Frozen", prompt: null, negativePrompt: null, model: null });
    expect(JSON.stringify(detail)).not.toContain("private@example.com");
    expect(detail).not.toHaveProperty("ownerId");
    expect(detail).not.toHaveProperty("reviewNote");
    expect(serializeFeaturedGalleryWork(work as never)).toMatchObject({ authorName: "Frozen", authorAvatar: null, prompt: "作者未公开提示词" });
  });
});
