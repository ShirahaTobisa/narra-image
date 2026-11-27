import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, getReport } = vi.hoisted(() => ({ requireAdmin: vi.fn(), getReport: vi.fn() }));
vi.mock("@/lib/server/current-user", () => ({ requireAdminRecord: requireAdmin }));
vi.mock("@/lib/server/user-ip-report", () => ({ getUserIpReport: getReport }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));

import AdminUserIpsPage from "@/app/admin/users/ips/page";

const firstSeenAt = new Date("2026-11-27T00:00:00Z");
const lastSeenAt = new Date("2026-11-27T01:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue({ id: "admin", role: "ADMIN" });
  getReport.mockResolvedValue({
    page: 1, totalPages: 2, totalGroups: 21, trackedUsers: 4, totalUsers: 120, invalidIp: false,
    groups: [{ ipAddress: "203.0.113.10", userCount: 2, firstSeenAt, lastSeenAt, users: [
      { userId: "one", uid: 12, nickname: "Alice", oauthProvider: "discord", oauthId: "123456789", firstSeenAt, lastSeenAt },
      { userId: "two", uid: 79, nickname: "Bob", oauthProvider: "linuxdo", oauthId: "private-other-provider", firstSeenAt, lastSeenAt },
    ] }],
  });
});

describe("admin IP report page", () => {
  it("does not query IP records without administrator authorization", async () => {
    requireAdmin.mockRejectedValueOnce(new Error("没有管理员权限"));
    await expect(AdminUserIpsPage()).rejects.toThrow("redirect:/login");
    expect(getReport).not.toHaveBeenCalled();
  });

  it("shows a global group with account links and dates, rather than one selected user", async () => {
    const html = renderToStaticMarkup(await AdminUserIpsPage());
    expect(getReport).toHaveBeenCalledWith({ page: 1, sharedOnly: true, ip: "" });
    expect(html).toContain("已记录 4 / 120 个账号");
    expect(html).toContain("203.0.113.10");
    expect(html).toContain("/admin/users?q=%2312");
    expect(html).toContain("/admin/users?q=%2379");
    expect(html).toContain("Discord 123456789");
    expect(html).not.toContain("private-other-provider");
    expect(html).toContain('dateTime="2026-11-27T01:00:00.000Z"');
    expect(html).toContain("UTC+9");
  });

  it("preserves the all-IP scope and address filter through pagination", async () => {
    const html = renderToStaticMarkup(await AdminUserIpsPage({ searchParams: Promise.resolve({ shared: "0", ip: " 203.0.113.10 ", page: "1" }) }));
    expect(getReport).toHaveBeenCalledWith({ page: 1, sharedOnly: false, ip: "203.0.113.10" });
    expect(html).toContain("page=2&amp;shared=0&amp;ip=203.0.113.10");
  });

  it("explains missing historical records and reports invalid IP searches", async () => {
    getReport.mockResolvedValueOnce({ groups: [], page: 1, totalPages: 0, totalGroups: 0, trackedUsers: 0, totalUsers: 120, invalidIp: true });
    const html = renderToStaticMarkup(await AdminUserIpsPage({ searchParams: Promise.resolve({ ip: "invalid" }) }));
    expect(html).toContain("请输入完整有效的 IPv4 或 IPv6 地址");
    expect(html).toContain("已有账号再次访问时也会纳入");
  });
});
