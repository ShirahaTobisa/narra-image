import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), revalidate: vi.fn(), admin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag: mocks.revalidate }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: mocks.find, update: mocks.update } } }));
vi.mock("@/lib/server/current-user", () => ({ requireAdminRecord: mocks.admin }));

import { PATCH } from "@/app/api/admin/users/[id]/ban/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.admin.mockResolvedValue({ id: "admin" });
  mocks.find.mockResolvedValue({ id: "target" });
});

describe("封禁变更立即失效公开作品缓存", () => {
  it.each([false, true])("banned=%s 成功提交后立即失效，不保留旧作品缓存", async (banned) => {
    mocks.update.mockResolvedValue({ id: "target", bannedAt: banned ? new Date() : null });
    const response = await PATCH(new Request("https://site.invalid/api/admin/users/target/ban", {
      method: "PATCH", body: JSON.stringify({ banned }),
    }), { params: Promise.resolve({ id: "target" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).data.user.banned).toBe(banned);
    expect(mocks.revalidate).toHaveBeenCalledWith("featured-works", { expire: 0 });
    expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(mocks.revalidate.mock.invocationCallOrder[0]);
  });

  it("不存在或更新失败时不声称已撤销缓存", async () => {
    mocks.find.mockResolvedValueOnce(null);
    const request = () => new Request("https://site.invalid/ban", { method: "PATCH", body: '{"banned":true}' });
    expect((await PATCH(request(), { params: Promise.resolve({ id: "target" }) })).status).toBe(404);
    mocks.update.mockRejectedValueOnce(new Error("synthetic database failure"));
    expect((await PATCH(request(), { params: Promise.resolve({ id: "target" }) })).status).toBe(400);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
