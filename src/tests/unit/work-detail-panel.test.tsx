import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({ download: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/components/works/download-image", () => ({ downloadImage: mocks.download }));

import { WorkDetailPanel } from "@/components/works/work-detail-panel";
import { serializePublicWorkDetail, serializeWork } from "@/lib/prisma-mappers";

import { createPrivacyWork, workPrivacySentinels } from "./helpers/work-privacy-fixtures";

const detailUrl = "https://homepage.unit.invalid/works/work_privacy_fixture";

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public image detail consumer", () => {
  it("renders redacted null prompts without exposing owner controls and retains full-image actions", async () => {
    const user = userEvent.setup();
    const work = serializePublicWorkDetail(serializeWork(createPrivacyWork()));

    render(<WorkDetailPanel detailUrl={detailUrl} isOwner={false} work={work} />);

    expect(screen.getByText("作者未公开提示词。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看完整提示词" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "申请下架" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "返回作品页" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下载图片" }));
    expect(mocks.download).toHaveBeenCalledWith(work.url);
    await user.click(screen.getByRole("button", { name: "作品图片" }));
    const enlarged = await screen.findByRole("img", { name: "作品大图" });
    const imageSource = new URL(enlarged.getAttribute("src")!, detailUrl);
    expect(imageSource.searchParams.get("url")).toBe(work.url);
    expect(enlarged).toHaveClass("object-contain");
  });

  it("allows full published positive and negative prompts without management data", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const work = serializePublicWorkDetail(serializeWork(createPrivacyWork({ showPromptPublic: true })));

    render(<WorkDetailPanel detailUrl={detailUrl} isOwner={false} work={work} />);
    await user.click(screen.getByRole("button", { name: "查看完整提示词" }));
    await user.click(screen.getByRole("button", { name: "复制提示词" }));

    expect(writeText).toHaveBeenCalledWith(
      `主提示词:\n${workPrivacySentinels.prompt}\n\n负向提示词:\n${workPrivacySentinels.negativePrompt}`,
    );
    expect(screen.queryByText(workPrivacySentinels.reviewNote)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "申请下架" })).not.toBeInTheDocument();
  });
});

describe("owner detail management compatibility", () => {
  it("retains cleaned image history and private prompts without requesting or reusing its file", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const work = serializeWork(createPrivacyWork({
      showcaseStatus: "PRIVATE", mediaAssetId: "cleaned_asset", mediaAsset: { state: "DELETED", activeObjectId: null },
    }));
    render(<WorkDetailPanel detailUrl={detailUrl} isOwner work={work} />);

    expect(screen.getByTestId("work-image")).toHaveAttribute("data-availability", "cleaned");
    expect(screen.getByText("图片已清理")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "作品图片" })).not.toBeInTheDocument();
    for (const name of ["下载图片", "投稿首页"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      await user.click(button);
    }
    await user.click(screen.getByRole("button", { name: "查看完整提示词" }));
    const fullPrompts = screen.getAllByText(workPrivacySentinels.prompt, { normalizer: (text) => text });
    for (const fullPrompt of fullPrompts) expect(fullPrompt.textContent).toBe(workPrivacySentinels.prompt);
    expect(work).toMatchObject({ generationStatus: "succeeded", jobId: workPrivacySentinels.jobId });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains private prompts, rejection notes and opt-in submission", async () => {
    const user = userEvent.setup();
    const work = serializeWork(createPrivacyWork({ showcaseStatus: "PRIVATE" }));
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkDetailPanel detailUrl={detailUrl} isOwner work={work} />);

    expect(screen.getByText(workPrivacySentinels.reviewNote)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看完整提示词" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回作品页" })).toHaveAttribute("href", "/works");
    await user.click(screen.getByRole("button", { name: "投稿首页" }));
    const publishPrompt = screen.getByRole("checkbox", { name: "允许公开页面显示完整提示词" });
    expect(publishPrompt).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "公开我的昵称" })).not.toBeChecked();
    expect(screen.getByText(/公开署名：匿名创作者/)).toBeInTheDocument();
    await user.click(publishPrompt);
    await user.click(screen.getByRole("button", { name: "确认投稿" }));

    expect(fetchMock).toHaveBeenCalledWith(`/api/me/works/${work.id}/showcase`, expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ action: "submit", showPromptPublic: true, showAuthorPublic: false }),
    }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("shows the current nickname for explicit author opt-in and submits only the choice", async () => {
    const user = userEvent.setup();
    const work = serializeWork(createPrivacyWork({ showcaseStatus: "PRIVATE" }));
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkDetailPanel detailUrl={detailUrl} isOwner work={work} />);

    await user.click(screen.getByRole("button", { name: "投稿首页" }));
    await user.click(screen.getByRole("checkbox", { name: "公开我的昵称" }));
    expect(screen.getByText(/公开署名：Public author nickname/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认投稿" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: "submit", showPromptPublic: false, showAuthorPublic: true });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("does not offer a blank nickname as public authorship", async () => {
    const user = userEvent.setup();
    const work = { ...serializeWork(createPrivacyWork({ showcaseStatus: "PRIVATE" })), authorNickname: "   " };
    render(<WorkDetailPanel detailUrl={detailUrl} isOwner work={work} />);
    await user.click(screen.getByRole("button", { name: "投稿首页" }));
    expect(screen.getByRole("checkbox", { name: "公开我的昵称" })).toBeDisabled();
    expect(screen.getByText(/请先在个人设置中填写昵称/)).toBeInTheDocument();
  });

  it("keeps a rejected public name visible in the open form and permits anonymous retry", async () => {
    const user = userEvent.setup();
    const work = serializeWork(createPrivacyWork({ showcaseStatus: "PRIVATE" }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "公开署名包含违规内容，请修改昵称或选择匿名投稿" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkDetailPanel detailUrl={detailUrl} isOwner work={work} />);
    await user.click(screen.getByRole("button", { name: "投稿首页" }));
    await user.click(screen.getByRole("checkbox", { name: "公开我的昵称" }));
    await user.click(screen.getByRole("button", { name: "确认投稿" }));
    const form = screen.getByRole("dialog", { name: "投稿首页精选" });
    expect(await within(form).findByRole("alert")).toHaveTextContent("公开署名包含违规内容");
    expect(mocks.refresh).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox", { name: "公开我的昵称" }));
    await user.click(screen.getByRole("button", { name: "确认投稿" }));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).showAuthorPublic).toBe(false);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it.each([
    { showcaseStatus: "PENDING", label: "撤回投稿", action: "withdraw" },
    { showcaseStatus: "FEATURED", label: "申请下架", action: "request_unfeature" },
  ] as const)("retains $label for the owner", async ({ showcaseStatus, label, action }) => {
    const user = userEvent.setup();
    const work = serializeWork(createPrivacyWork({ showcaseStatus }));
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkDetailPanel detailUrl={detailUrl} isOwner work={work} />);
    await user.click(screen.getByRole("button", { name: label }));

    expect(fetchMock).toHaveBeenCalledWith(`/api/me/works/${work.id}/showcase`, expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ action }),
    }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });
});
