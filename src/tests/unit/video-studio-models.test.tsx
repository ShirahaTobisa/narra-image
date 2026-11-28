import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { VideoStudio } from "@/components/video/video-studio";
import { conversationGeneration } from "./helpers/conversation-fixtures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/create/hooks/use-image-poller", () => ({ useImagePoller: vi.fn() }));

const channels = [{ id: "", name: "平台渠道", videoCreditCost: 23, defaultModel: "sora-2", models: ["sora-2", "gpt-image-2", "seedream-5-5", "h3", "*"] }];
const viewer = { credits: 100, role: "user" as const };
const generated = () => conversationGeneration("video", "conversation_a", { generationType: "text_to_video", model: "h3", status: "pending" });
const selection = (name: string) => screen.getByRole("combobox", { name });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify({ data: url === "/api/me/model-quotas"
    ? { models: [{ model: "h3", limit: 10, remaining: 8, userRemaining: 1 }] }
    : { generation: generated() } }))));
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:reference") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("video studio model capabilities", () => {
  it("shows the selected model's configured price instead of the first channel's price", async () => {
    render(<VideoStudio currentUser={viewer} channels={[{ ...channels[0], videoCreditCosts: { "sora-2": 23, h3: 61 } }]} />);
    expect(screen.getByRole("button", { name: "生成视频（23 积分）" })).toBeInTheDocument();
    fireEvent.change(selection("模型"), { target: { value: "h3" } });
    expect(screen.getByRole("button", { name: "生成视频（61 积分）" })).toBeInTheDocument();
    expect(await screen.findByText(/全站今日剩余 8 \/ 10 次/)).toBeInTheDocument();
  });

  it("only offers video models and submits valid H3 settings after changing models", async () => {
    render(<VideoStudio currentUser={viewer} channels={channels} />);
    expect(within(selection("模型")).getAllByRole("option").map((option) => option.textContent)).toEqual(["sora-2", "h3"]);
    fireEvent.change(selection("时长"), { target: { value: "12" } });
    fireEvent.change(selection("分辨率"), { target: { value: "1080p" } });
    fireEvent.change(selection("模型"), { target: { value: "h3" } });
    expect(within(selection("时长")).getAllByRole("option").map((option) => option.textContent)).toEqual(["4 秒", "6 秒", "8 秒"]);
    expect(selection("时长")).toHaveValue("8");
    expect(selection("分辨率")).toHaveValue("720p");
    expect(screen.queryByRole("option", { name: "1080p" })).toBeNull();
    expect(screen.getByText(/视频可用 3 天/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/描述你想生成的视频/), { target: { value: "A landscape in motion" } });
    fireEvent.change(selection("时长"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "生成视频（23 积分）" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/generate")).toBe(true));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/generate")?.[1]?.body))).toMatchObject({ model: "h3", durationSeconds: 6, size: "1280x736" });
  });

  it("retries the original H3 image and duration while a different draft is selected", async () => {
    const failed = conversationGeneration("failed", "conversation_a", { status: "failed", generationType: "image_to_video", model: "h3", prompt: "Original video", sourceImageUrls: ["/api/images/original"], durationSeconds: 6, aspectRatio: "9:16", size: "1920x1080" });
    render(<VideoStudio currentUser={viewer} channels={channels} initialGenerations={[failed]} />);
    fireEvent.change(screen.getByPlaceholderText(/描述你想生成的视频/), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = vi.mocked(fetch).mock.calls[0][1]?.body as FormData;
    expect(Object.fromEntries(body)).toMatchObject({ model: "h3", prompt: "Original video", size: "736x1280", durationSeconds: "6", referenceImageUrls: "/api/images/original" });
    expect(screen.getByPlaceholderText(/描述你想生成的视频/)).toHaveValue("Keep this draft");
  });

  it("downloads H3 through the own-site route without buffering or opening a fallback URL", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const video = { ...generated(), status: "succeeded" as const, videos: [{ id: "owned_video", url: "/api/videos/owned_video/content", posterUrl: "/api/videos/owned_video/content?variant=poster" }] };
    const { container } = render(<VideoStudio currentUser={viewer} channels={channels} initialGenerations={[video]} />);
    expect(container.querySelector("video[controls]")).toHaveAttribute("src", video.videos[0].url);
    expect(container.querySelector("video[controls]")).toHaveAttribute("poster", video.videos[0].posterUrl);
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    expect((click.mock.contexts[0] as HTMLAnchorElement).getAttribute("href")).toMatch(/^\/api\/videos\/owned_video\/content\?download=1&filename=\d{2}-\d{2}-\d{2}-\d{2}$/);
    expect(fetch).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("does not offer a GPT fallback when there is no video channel", () => {
    render(<VideoStudio currentUser={viewer} channels={[{ ...channels[0], defaultModel: "gpt-image-2", models: ["gpt-image-2", "*"] }]} />);
    expect(within(selection("模型")).queryByRole("option")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/描述你想生成的视频/), { target: { value: "A valid prompt" } });
    expect(screen.getByRole("button", { name: "生成视频" })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
