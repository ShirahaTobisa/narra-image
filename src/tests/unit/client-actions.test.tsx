import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CheckInButton } from "@/components/benefits/check-in-button";
import { InviteClaimBoard } from "@/components/invites/invite-claim-board";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("签到遇到网关 HTML 后显示错误，按钮可以重试", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => { throw new SyntaxError("HTML"); } })));
  render(<CheckInButton checkedInToday={false} rewardCredits={5} />);
  fireEvent.click(screen.getByRole("button", { name: "签到 +5" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("请求失败，请稍后再试"));
  expect(screen.getByRole("button", { name: "签到 +5" })).toBeEnabled();
});

it("领取邀请码断网后留在原处，显示错误并允许重试", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  render(<InviteClaimBoard batches={[{ id: "one", remainingCount: 1, totalCount: 1, title: "测试" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "领取邀请码" }));
  expect(await screen.findByText("网络连接失败，请稍后再试")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "领取邀请码" })).toBeEnabled();
  expect(push).not.toHaveBeenCalled();
});

it("领取一个批次时禁用其他批次，避免重复消耗验证码", async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { finish = resolve; })));
  render(<InviteClaimBoard batches={["one", "two"].map((id) => ({ id, remainingCount: 1, totalCount: 1, title: id }))} />);
  fireEvent.click(screen.getAllByRole("button", { name: "领取邀请码" })[0]);
  expect(await screen.findByRole("button", { name: "领取中..." })).toBeDisabled();
  expect(screen.getByRole("button", { name: "领取邀请码" })).toBeDisabled();
  finish({ ok: false, json: async () => ({ error: "已领完" }) });
  expect(await screen.findByText("已领完")).toBeInTheDocument();
});

it("离开领取页面后，迟到成功不会把用户拉回注册页", async () => {
  let finish!: (value: unknown) => void;
  const fetchMock = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  vi.stubGlobal("fetch", fetchMock);
  const { unmount } = render(<InviteClaimBoard batches={[{ id: "one", remainingCount: 1, totalCount: 1, title: "测试" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "领取邀请码" }));
  unmount();
  await act(async () => { finish({ ok: true, json: async () => ({ data: { registerUrl: "/register?inviteCode=test" } }) }); });
  expect(push).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
