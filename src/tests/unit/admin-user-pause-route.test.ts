import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockRequireAdmin } = vi.hoisted(() => ({
  mockDb: { user: { findUnique: vi.fn(), update: vi.fn() } },
  mockRequireAdmin: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/server/current-user", () => ({ requireAdminRecord: mockRequireAdmin }));

import { PATCH } from "@/app/api/admin/users/[id]/pause/route";

const call = (body: unknown) => PATCH(
  new Request("http://localhost/api/admin/users/u1/pause", {
    body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, method: "PATCH",
  }),
  { params: Promise.resolve({ id: "u1" }) },
);

describe("后台暂停 / 解除暂停用户的站内提交", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ id: "admin" });
    mockDb.user.findUnique.mockResolvedValue({ id: "u1" });
    mockDb.user.update.mockResolvedValue({});
  });

  it("暂停只记下暂停时间", async () => {
    expect((await call({ paused: true })).status).toBe(200);
    expect(mockDb.user.update).toHaveBeenCalledWith({ data: { generationPausedAt: expect.any(Date) }, where: { id: "u1" } });
  });

  it("解除暂停同时记下解除时间，之前被拒的不再计数", async () => {
    expect((await call({ paused: false })).status).toBe(200);
    expect(mockDb.user.update).toHaveBeenCalledWith({
      data: { generationPausedAt: null, moderationClearedAt: expect.any(Date) }, where: { id: "u1" },
    });
  });

  it("参数不对、用户不存在、不是管理员都不改库", async () => {
    expect((await call({ paused: "yes" })).status).toBe(400);
    mockDb.user.findUnique.mockResolvedValueOnce(null);
    expect((await call({ paused: true })).status).toBe(404);
    mockRequireAdmin.mockRejectedValueOnce(new Error("无权限"));
    expect((await call({ paused: true })).status).toBe(400);
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });
});
