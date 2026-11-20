import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ providers: vi.fn(), turnstile: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { inviteBatch: { findMany: async () => [] } } }));
vi.mock("@/lib/server/current-user", () => ({ getCurrentUserRecord: async () => null }));
vi.mock("@/lib/server/auth-cover", () => ({ getAuthCover: async () => ({}) }));
vi.mock("@/lib/auth/oauth-config", () => ({ getEnabledOAuthProviders: mocks.providers }));
vi.mock("@/lib/auth/turnstile", () => ({ getPublicTurnstileConfig: mocks.turnstile }));
vi.mock("@/components/marketing/auth-shell", () => ({ AuthShell: ({ children, footnote }: { children: ReactNode; footnote: ReactNode }) => <main>{children}{footnote}</main> }));
vi.mock("@/components/auth/turnstile-widget", () => ({ TurnstileWidget: () => null }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`redirect:${path}`); },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import LoginPage from "@/app/login/page";
import RegisterPage from "@/app/register/page";
import InviteClaimPage from "@/app/invite-claim/page";

describe("公开登录页面", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providers.mockResolvedValue([{ type: "discord", displayName: "Discord" }, { type: "linuxdo", displayName: "LinuxDo" }]);
    mocks.turnstile.mockResolvedValue({ isEnabled: true, siteKey: "test-key", protectLogin: true, protectRegister: true });
  });

  it("公开入口只有 Discord，无邮箱、邀请码或 LinuxDo，且不加载验证码配置", async () => {
    render(await LoginPage({}));
    expect(screen.getByRole("link", { name: /使用 Discord 登录/ })).toHaveAttribute("href", "/api/auth/oauth/discord");
    expect(screen.queryByLabelText("邮箱")).not.toBeInTheDocument();
    expect(screen.queryByText(/邀请码/)).not.toBeInTheDocument();
    expect(screen.queryByText(/LinuxDo/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "管理员恢复登录" })).toHaveAttribute("href", "/login?admin=1");
    expect(mocks.turnstile).not.toHaveBeenCalled();
  });

  it("管理员恢复入口保留邮箱表单和验证码配置", async () => {
    render(await LoginPage({ searchParams: Promise.resolve({ admin: "1" }) }));
    expect(screen.getByLabelText("邮箱")).toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /使用 Discord 登录/ })).not.toBeInTheDocument();
    expect(mocks.turnstile).toHaveBeenCalledOnce();
    expect(mocks.providers).not.toHaveBeenCalled();
  });

  it("Discord 未启用时明确提示，不回退到公开邮箱登录", async () => {
    mocks.providers.mockResolvedValue([]);
    render(await LoginPage({}));
    expect(screen.getByText(/Discord 登录暂不可用/)).toBeInTheDocument();
    expect(screen.queryByLabelText("邮箱")).not.toBeInTheDocument();
  });

  it("旧注册和领码页面转到统一 Discord 登录入口", async () => {
    await expect(RegisterPage()).rejects.toThrow("redirect:/login");
    await expect(InviteClaimPage()).rejects.toThrow("redirect:/login");
  });
});
