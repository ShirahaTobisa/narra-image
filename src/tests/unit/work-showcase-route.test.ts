import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  autoApprove: vi.fn(),
  checkInput: vi.fn(),
  currentUser: vi.fn(),
  imageUpdate: vi.fn(),
  videoUpdate: vi.fn(),
  target: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidateTag: mocks.revalidate }));
vi.mock("@/lib/db", () => ({ db: {
  generationImage: { update: mocks.imageUpdate, updateMany: mocks.imageUpdate },
  generatedVideo: { update: mocks.videoUpdate, updateMany: mocks.videoUpdate },
} }));
vi.mock("@/lib/server/current-user", () => ({
  requireCurrentUserRecord: mocks.currentUser,
  requireAdminRecord: async () => ({ id: "admin" }),
}));
vi.mock("@/lib/server/works", () => ({
  getWorkMutationTarget: mocks.target,
  getVideoMutationTarget: mocks.target,
  getWorkById: async () => null,
  getAdminWorkById: async () => null,
}));
vi.mock("@/lib/benefits/config", () => ({ isAutoApproveShowcase: mocks.autoApprove }));
vi.mock("@/lib/moderation/check", () => ({
  checkGenerationInput: mocks.checkInput,
  MODERATION_BLOCK_MESSAGES: ["提交内容包含违规描述，已拒绝生成"],
}));

import { PATCH as submit } from "@/app/api/me/works/[id]/showcase/route";
import { PATCH as review } from "@/app/api/admin/works/[id]/review/route";
import { POST as batchReview } from "@/app/api/admin/works/batch-review/route";

const submittedAt = "2026-11-21T01:00:00.000Z";
function target(overrides = {}) {
  return { featuredAt: null, job: { userId: "owner" }, publicAuthorName: null,
    showcaseStatus: "PRIVATE", submittedAt: null, ...overrides };
}
function request(body: unknown) {
  return new Request("https://site.invalid/api/me/works/work/showcase", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
const context = { params: Promise.resolve({ id: "work" }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.currentUser.mockResolvedValue({ id: "owner", nickname: "  投稿时昵称  " });
  mocks.target.mockResolvedValue(target());
  mocks.checkInput.mockResolvedValue({ allowed: true });
  mocks.autoApprove.mockResolvedValue(false);
  mocks.imageUpdate.mockResolvedValue({ count: 1 });
  mocks.videoUpdate.mockResolvedValue({ count: 1 });
});

describe("投稿署名快照", () => {
  it("默认匿名，不使用客户端伪造署名，也不送审私有昵称", async () => {
    const response = await submit(request({ action: "submit", publicAuthorName: "客户端冒名" }), context);
    expect(response.status).toBe(200);
    expect(mocks.imageUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ publicAuthorName: null, showcaseStatus: "PENDING" }),
    }));
    expect(mocks.checkInput).not.toHaveBeenCalled();
  });

  it.each(["image", "video"])("%s 只送审登录用户的当次昵称并保存同一份快照", async (mediaType) => {
    let finish!: (result: { allowed: true }) => void;
    mocks.checkInput.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = submit(request({ action: "submit", mediaType, showAuthorPublic: true, publicAuthorName: "客户端冒名" }), context);
    await vi.waitFor(() => expect(mocks.checkInput).toHaveBeenCalledWith({ builtIn: true, userId: "owner", prompt: "投稿时昵称" }));
    expect(mocks.imageUpdate).not.toHaveBeenCalled();
    expect(mocks.videoUpdate).not.toHaveBeenCalled();
    mocks.currentUser.mockResolvedValue({ id: "owner", nickname: "之后修改的昵称" });
    finish({ allowed: true });
    expect((await pending).status).toBe(200);
    expect(mediaType === "video" ? mocks.videoUpdate : mocks.imageUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ publicAuthorName: "投稿时昵称", showcaseStatus: "PENDING" }),
    }));
  });

  it.each([null, "", " \n\t "])("署名选择拒绝空昵称 %j", async (nickname) => {
    mocks.currentUser.mockResolvedValue({ id: "owner", nickname });
    const response = await submit(request({ action: "submit", showAuthorPublic: true }), context);
    expect(response.status).toBe(400);
    expect(mocks.imageUpdate).not.toHaveBeenCalled();
    expect(mocks.checkInput).not.toHaveBeenCalled();
  });

  it.each([false, true])("自动通过=%s 也不得跳过昵称拒绝或审核故障", async (autoApprove) => {
    mocks.autoApprove.mockResolvedValue(autoApprove);
    mocks.checkInput.mockResolvedValue({ allowed: false, message: "内容审核暂时无法完成" });
    expect((await submit(request({ action: "submit", showAuthorPublic: true }), context)).status).toBe(400);
    expect(mocks.imageUpdate).not.toHaveBeenCalled();
  });

  it("明确违规昵称与审核抛错都不写入投稿", async () => {
    mocks.checkInput.mockResolvedValueOnce({ allowed: false, message: "提交内容包含违规描述，已拒绝生成" });
    const blocked = await submit(request({ action: "submit", showAuthorPublic: true }), context);
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error).toContain("公开署名包含违规内容");
    mocks.checkInput.mockRejectedValueOnce(new Error("审核不可用"));
    expect((await submit(request({ action: "submit", showAuthorPublic: true }), context)).status).toBe(400);
    expect(mocks.imageUpdate).not.toHaveBeenCalled();
  });

  it("自动通过只在昵称审核成功后公开同一份署名", async () => {
    mocks.autoApprove.mockResolvedValue(true);
    expect((await submit(request({ action: "submit", showAuthorPublic: true }), context)).status).toBe(200);
    expect(mocks.checkInput).toHaveBeenCalled();
    expect(mocks.imageUpdate.mock.calls[0][0].data).toMatchObject({ publicAuthorName: "投稿时昵称", showcaseStatus: "FEATURED" });
  });

  it("自动通过仍需验证原作品状态", async () => {
    mocks.autoApprove.mockResolvedValue(true);
    mocks.target.mockResolvedValue(target({ showcaseStatus: "FEATURED", publicAuthorName: "原署名" }));
    expect((await submit(request({ action: "submit", showAuthorPublic: true }), context)).status).toBe(409);
    expect(mocks.checkInput).not.toHaveBeenCalled();
    expect(mocks.imageUpdate).not.toHaveBeenCalled();
  });

  it("非作者不能触发送审或覆盖署名", async () => {
    mocks.target.mockResolvedValue(target({ job: { userId: "someone-else" } }));
    expect((await submit(request({ action: "submit", showAuthorPublic: true }), context)).status).toBe(404);
    expect(mocks.checkInput).not.toHaveBeenCalled();
    expect(mocks.imageUpdate).not.toHaveBeenCalled();
  });

  it("审核等待中状态已改变则不覆盖新的作品状态", async () => {
    mocks.imageUpdate.mockResolvedValue({ count: 0 });
    const response = await submit(request({ action: "submit", showAuthorPublic: true }), context);
    expect(response.status).toBe(409);
    expect(mocks.imageUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "work", showcaseStatus: "PRIVATE", job: { userId: "owner" } }),
    }));
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("撤回不重写已送审昵称，也不重新审核个人资料", async () => {
    mocks.target.mockResolvedValue(target({ showcaseStatus: "PENDING", publicAuthorName: "原署名" }));
    expect((await submit(request({ action: "withdraw", showAuthorPublic: true }), context)).status).toBe(200);
    expect(mocks.imageUpdate.mock.calls[0][0].data).not.toHaveProperty("publicAuthorName");
    expect(mocks.checkInput).not.toHaveBeenCalled();
  });
});

describe("管理员按已看到的投稿版本审批", () => {
  beforeEach(() => {
    mocks.target.mockResolvedValue(target({ showcaseStatus: "PENDING", publicAuthorName: "已审署名", submittedAt: new Date(submittedAt) }));
  });

  it("批准只改状态，个人改名或恶意 payload 不能替换署名", async () => {
    const response = await review(request({ action: "approve_feature", submittedAt, publicAuthorName: "绕过审核" }), context);
    expect(response.status).toBe(200);
    expect(mocks.imageUpdate.mock.calls[0][0].data).not.toHaveProperty("publicAuthorName");
    expect(mocks.imageUpdate.mock.calls[0][0].where).toMatchObject({ showcaseStatus: "PENDING", submittedAt: new Date(submittedAt) });
  });

  it("旧页面审批遇到撤回后重新投稿必须刷新，不能批准新署名", async () => {
    const response = await review(request({ action: "approve_feature", submittedAt: "2026-11-20T01:00:00.000Z" }), context);
    expect(response.status).toBe(409);
    expect(mocks.imageUpdate).not.toHaveBeenCalled();
  });

  it("未携带已查看的投稿版本不能批准", async () => {
    const response = await review(request({ action: "approve_feature" }), context);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("刷新");
    expect(mocks.imageUpdate).not.toHaveBeenCalled();
  });

  it("读取目标后再改变投稿版本也不会批准", async () => {
    mocks.imageUpdate.mockResolvedValue({ count: 0 });
    expect((await review(request({ action: "approve_feature", submittedAt }), context)).status).toBe(409);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("批量审核同样跳过旧版本并保留当前署名", async () => {
    const response = await batchReview(request({ action: "approve_feature", items: [
      { id: "old", mediaType: "image", submittedAt: "2026-11-20T01:00:00.000Z" },
      { id: "legacy-page", mediaType: "image" },
      { id: "current", mediaType: "video", submittedAt },
    ] }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ updatedIds: ["current"], skippedIds: ["old", "legacy-page"] });
    expect(mocks.imageUpdate).not.toHaveBeenCalled();
    expect(mocks.videoUpdate.mock.calls[0][0].data).not.toHaveProperty("publicAuthorName");
  });
});
