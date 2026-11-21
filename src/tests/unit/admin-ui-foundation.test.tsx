import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const { mockPush } = vi.hoisted(() => ({
  mockPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/moderation",
  useRouter: () => ({ push: mockPush, refresh: vi.fn() }),
}));

import { AdminFrame } from "@/components/admin/admin-frame";
import { ModerationConfigForm } from "@/components/admin/moderation-config-form";
import { ModerationReviewsBoard } from "@/components/admin/moderation-reviews-board";
import {
  ADMIN_NAV_GROUPS,
  isAdminNavItemActive,
  resolveAdminBreadcrumb,
} from "@/components/admin/constants";
import { useAdminToast } from "@/components/admin/hooks/use-admin-toast";
import { AdminCommandPalette } from "@/components/admin/ui/admin-command-palette";
import { AdminConfirmDialog } from "@/components/admin/ui/admin-modal";
import { AdminSwitch } from "@/components/admin/ui/admin-switch";
import { AdminTabs } from "@/components/admin/ui/admin-tabs";
import { AdminToastProvider } from "@/components/admin/ui/admin-toast-provider";

function ToastTriggerHarness() {
  const toast = useAdminToast();
  return (
    <button
      type="button"
      onClick={() => toast.success("配置已保存", "新的限制已生效")}
    >
      触发通知
    </button>
  );
}

describe("后台基础 UI 原语与路由契约", () => {
  it("准确说明站内审核暂停、失败拒绝和独立风险阈值", () => {
    render(<ModerationConfigForm config={{
      aiBaseUrl: "https://moderation.invalid/v1", aiConfigured: false, aiEnabled: false,
      aiModel: null, aiThreshold: 0.5, isEnabled: false, sensitiveWordsEnabled: true, updatedAt: null,
    }} words={[]} />);

    expect(screen.getByText(/关闭后站内生图将暂停/)).toBeInTheDocument();
    expect(screen.getByText(/关闭 AI 审核或审核失败时.*拒绝站内生图/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("omni-moderation-latest")).toBeInTheDocument();
    expect(screen.getByText(/分数达到这个阈值才拒绝.*未成年人的色情内容例外：审核模型判定属于这一类就拒绝/)).toBeInTheDocument();
    expect(screen.getByText(/判断不了图片里人物的年龄/)).toBeInTheDocument();
    expect(screen.queryByText(/降级放行/)).not.toBeInTheDocument();
  });

  it("本机审图拒的记录写明拒的是参考图，远程审核的不写", () => {
    const review = {
      aiScore: 0.23, category: "sexual", createdAt: "2026-11-21T12:08:02.000Z", hitWords: [], kind: "ai_moderation",
      negativePrompt: null, prompt: "生成提示词",
      user: { banned: false, email: "a@example.com", id: "u1", nickname: null, uid: 49 },
    };
    render(<AdminToastProvider><ModerationReviewsBoard adminId="admin" kind="" offenders={[]} reviews={[
      { ...review, id: "local", aiModel: "nsfwjs/MobileNetV2Mid@4.4.0" },
      { ...review, id: "remote", aiModel: "omni-moderation-latest" },
    ]} /></AdminToastProvider>);

    expect(screen.getAllByText(/违规分 0\.23 · sexual/)).toHaveLength(2);
    expect(screen.getAllByText(/拒的是参考图/)).toHaveLength(1);
  });

  it("违规榜标出暂停中的人并能点开他的记录，上游拒绝单列一类", async () => {
    const user = userEvent.setup();
    const offender = {
      banned: false, count: 4, email: "paused@example.com", lastTriggerAt: "2026-11-21T17:07:05.000Z",
      nickname: null, paused: true, recentCount: 4, uid: 112, userId: "u112",
    };
    render(<AdminToastProvider><ModerationReviewsBoard adminId="admin" kind="" offenders={[
      offender,
      { ...offender, count: 9, email: "earlier@example.com", paused: false, recentCount: 0, uid: 7, userId: "u7" },
    ]} reviews={[{
      aiModel: null, aiScore: null, category: null, createdAt: "2026-11-21T17:07:05.000Z", hitWords: [], id: "job1",
      kind: "provider", negativePrompt: null, prompt: "上游拒掉的提示词",
      user: { banned: false, email: "paused@example.com", id: "u112", nickname: null, uid: 112 },
    }]} /></AdminToastProvider>);

    expect(screen.getByText("其中 1 人暂停中")).toBeInTheDocument();
    expect(screen.getAllByText("暂停中")).toHaveLength(1);
    expect(screen.getByText("近 24 小时 4 次")).toBeInTheDocument();
    expect(screen.getByText("上游渠道拒绝")).toBeInTheDocument();
    expect(screen.getByText("上游拒绝")).toBeInTheDocument();
    expect(screen.getByText("过了本站审核，被出图渠道拒绝")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "看记录" })[0]);
    expect(mockPush).toHaveBeenCalledWith("/admin/moderation?q=%23112");
    expect(screen.getByPlaceholderText(/搜索 #编号/)).toHaveValue("#112");
  });

  it("准确解析全部关键后台路由的多级面包屑（修复 /admin/moderation 与设置子页）", () => {
    expect(resolveAdminBreadcrumb("/admin").title).toBe("控制台概览");
    expect(resolveAdminBreadcrumb("/admin/moderation")).toMatchObject({
      sectionCode: "MODERATION",
      title: "内容风控与拦截记录",
    });
    expect(resolveAdminBreadcrumb("/admin/settings/moderation")).toMatchObject({
      sectionCode: "MODERATION / RULES",
      title: "内容审核规则与词库",
    });
    expect(resolveAdminBreadcrumb("/admin/settings/storage").items.map((i) => i.label)).toEqual([
      "管理台",
      "系统设置",
      "图片存储",
    ]);
    expect(resolveAdminBreadcrumb("/admin/api").title).toBe("开放 API 密钥与速率限制");
  });

  it("区分独立提升的生图渠道与其余系统设置子页的高亮归属", () => {
    const allItems = ADMIN_NAV_GROUPS.flatMap((g) => g.items);
    const channelItem = allItems.find((i) => i.href === "/admin/settings/channels")!;
    const settingsItem = allItems.find((i) => i.href === "/admin/settings")!;
    const moderationItem = allItems.find((i) => i.href === "/admin/moderation")!;

    expect(isAdminNavItemActive(channelItem, "/admin/settings/channels")).toBe(true);
    expect(isAdminNavItemActive(settingsItem, "/admin/settings/channels")).toBe(false);
    expect(isAdminNavItemActive(settingsItem, "/admin/settings/storage")).toBe(true);
    expect(isAdminNavItemActive(moderationItem, "/admin/settings/moderation")).toBe(true);
  });

  it("通过 Portal 挂载确认弹窗并支持 Escape 关闭", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onConfirm = vi.fn();

    render(
      <div style={{ backdropFilter: "blur(20px)" }}>
        <AdminConfirmDialog
          open
          onClose={onClose}
          onConfirm={onConfirm}
          title="危险操作确认"
          description="确认后不可撤销"
          confirmLabel="确认执行"
        />
      </div>,
    );

    const dialog = screen.getByRole("dialog", { name: "危险操作确认" });
    expect(dialog.parentElement?.parentElement).toBe(document.body);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "确认执行" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("支持标准 role=switch 开关切换与全局 Toast 通知", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();

    render(
      <AdminToastProvider>
        <AdminSwitch
          label="自动审核开关"
          checked={false}
          onCheckedChange={onCheckedChange}
        />
        <ToastTriggerHarness />
      </AdminToastProvider>,
    );

    await user.click(screen.getByRole("switch", { name: "自动审核开关" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);

    await user.click(screen.getByRole("button", { name: "触发通知" }));
    expect(await screen.findByText("配置已保存")).toBeInTheDocument();
    expect(screen.getByText("新的限制已生效")).toBeInTheDocument();
  });

  it("支持快捷指令面板关键词检索并回车跳转", async () => {
    const user = userEvent.setup();
    mockPush.mockReset();
    const onOpenChange = vi.fn();

    render(<AdminCommandPalette open onOpenChange={onOpenChange} />);

    const input = await screen.findByPlaceholderText(/输入模块名称或关键词快速跳转/);
    await user.type(input, "渠道{Enter}");

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/admin/settings/channels");
    });
  });

  it("采用温暖浅色侧边栏与白底浮起滑块 Segmented Control", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();

    render(
      <AdminFrame
        currentUser={{ avatarUrl: null, id: "admin_u12345678", nickname: "lucky" }}
      >
        <AdminTabs
          ariaLabel="趋势指标切换"
          layoutId="test-trend-tabs"
          value="generations"
          onChange={onTabChange}
          options={[
            { label: "生成任务量", value: "generations" },
            { label: "积分消耗量", value: "credits" },
          ]}
        />
      </AdminFrame>,
    );

    const activeNav = screen.getByRole("link", { name: "内容风控" });
    expect(activeNav).toHaveAttribute("aria-current", "page");

    const activeTab = screen.getByRole("tab", { name: "生成任务量" });
    expect(activeTab).toHaveAttribute("aria-selected", "true");
    expect(activeTab.className).toContain("text-[#292524]");

    await user.click(screen.getByRole("tab", { name: "积分消耗量" }));
    expect(onTabChange).toHaveBeenCalledWith("credits");
  });
});
