import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/settings/redeem-code-form", () => ({ RedeemCodeForm: () => null }));

import { ProfileForm } from "@/components/settings/profile-form";

const user = {
  id: "existing-user", email: "existing@example.com", nickname: "旧昵称", avatarUrl: null,
  credits: 123, role: "user" as const, uid: 1,
};

function profile(oauthProvider: string | null, canUnlinkOAuth = false) {
  return <ProfileForm user={canUnlinkOAuth ? { ...user, role: "admin" } : user}
    oauthProvider={oauthProvider} canUnlinkOAuth={canUnlinkOAuth}
    oauthProviders={[{ type: "discord", displayName: "Discord" }]} queryNotice={null} />;
}

describe("个人设置的 Discord 登录迁移", () => {
  it.each([null, "linuxdo"])("旧账号登录源 %s 可在有效会话内绑定 Discord", (provider) => {
    render(profile(provider));
    expect(screen.getByRole("link", { name: "绑定 Discord" })).toHaveAttribute("href", "/api/auth/oauth/discord");
    expect(screen.queryByRole("button", { name: "解绑" })).not.toBeInTheDocument();
    if (provider) expect(screen.getByText(/改绑 Discord 会替换原登录绑定/)).toBeInTheDocument();
  });

  it("普通 Discord 用户保留绑定，不能解绑最后的登录方式", () => {
    render(profile("discord"));
    expect(screen.queryByRole("link", { name: "绑定 Discord" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "解绑" })).not.toBeInTheDocument();
    expect(screen.getByText(/普通账号不能解绑 Discord/)).toBeInTheDocument();
  });

  it("有密码恢复资格的管理员仍显示 Discord 解绑入口", () => {
    render(profile("discord", true));
    expect(screen.getByRole("button", { name: "解绑" })).toBeInTheDocument();
  });

  it("昵称只可在投稿时选择署名，邮箱不再被描述为普通账号登录凭证", () => {
    render(profile(null));
    expect(screen.getByText(/投稿默认匿名.*修改昵称不会改变已有投稿/)).toBeInTheDocument();
    expect(screen.getByText("投稿时可选择署名：旧昵称")).toBeInTheDocument();
    expect(screen.getByText(/普通账号通过 Discord 登录/)).toBeInTheDocument();
    expect(screen.queryByText(/邮箱为登录凭证/)).not.toBeInTheDocument();
    expect(screen.queryByText(/公开作品和首页画廊将优先展示昵称/)).not.toBeInTheDocument();
  });
});
