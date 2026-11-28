import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, Ref } from "react";

import { GeneratorStudio } from "@/components/create/generator-studio";
import { POLL_DELAYS_MS } from "@/components/create/constants";
import { conversationGeneration as generation, conversationPage as page } from "./helpers/conversation-fixtures";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const challenge = vi.hoisted(() => ({ reset: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/auth/turnstile-widget", async () => {
  const { useImperativeHandle } = await import("react");
  return {
    TurnstileWidget: ({ onVerify, ref }: { onVerify: (token: string) => void; ref: Ref<{ reset: () => void }> }) => {
      useImperativeHandle(ref, () => ({ reset: challenge.reset }), []);
      return <><button type="button" onClick={() => onVerify("first-token")}>Verify first</button><button type="button" onClick={() => onVerify("next-token")}>Verify next</button></>;
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type PendingRequest = { url: string; options?: RequestInit; reply: ReturnType<typeof deferred<Response>> };
type StudioProps = ComponentProps<typeof GeneratorStudio>;
const summary = (id: string, title: string, generationCount = 0) => ({ id, title, generationCount, generationIds: [], createdAt: "2026-10-01T00:00:00.000Z" });
const baseProps: StudioProps = {
  ownerId: "owner_a", currentUser: { credits: 500, role: "user" },
  checkInSummary: { checkInReward: 50, checkedInToday: false },
  initialConversations: [summary("conversation_a", "Chat A"), summary("conversation_b", "Chat B")],
  initialGenerationPage: page(),
};
let requests: PendingRequest[];
let preferences: Map<string, string>;
let resolveConversationDeletes: boolean;

function composer() {
  return screen.getByPlaceholderText(/输入提示词生成图片|描述你希望如何修改这些参考图/) as HTMLTextAreaElement;
}
function navigation() { return screen.getByRole("complementary", { name: "对话导航" }); }
function writePrompt(value: string) { fireEvent.change(composer(), { target: { value } }); }
function send() { fireEvent.click(screen.getByRole("button", { name: "发送" })); }
function newChat() { fireEvent.click(within(navigation()).getByRole("button", { name: /新建对话/ })); }
function selectChat(title: string) { fireEvent.click(within(navigation()).getByText(title)); }
function dropFiles(...names: string[]) {
  fireEvent.drop(composer().closest(".composer-silk")!, {
    dataTransfer: { files: names.map((name) => new File([name], name, { type: "image/png" })), types: ["Files"] },
  });
}
function findRequest(url: string, method = "POST") {
  const request = requests.find((item) => item.url === url && (item.options?.method ?? "GET") === method);
  if (!request) throw new Error(`Missing ${method} ${url}`);
  return request;
}
const generates = () => requests.filter((item) => item.url === "/api/generate");
async function reply(request: PendingRequest, body: unknown, status = 200) {
  await act(async () => { request.reply.resolve(new Response(JSON.stringify(body), { status })); });
}
const created = (id = "created_chat") => ({ data: { conversation: { ...summary(id, "Captured create"), updatedAt: "2026-10-01T00:00:00.000Z" } } });

beforeEach(() => {
  requests = [];
  preferences = new Map();
  resolveConversationDeletes = true;
  router.refresh.mockClear();
  challenge.reset.mockClear();
  vi.stubGlobal("innerWidth", 1440);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => preferences.get(key) ?? null,
    setItem: (key: string, value: string) => preferences.set(key, value),
    removeItem: (key: string) => preferences.delete(key),
  });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((file: File) => `blob:${file.name}`) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("fetch", vi.fn((url: string, options?: RequestInit) => {
    const request = { url, options, reply: deferred<Response>() };
    requests.push(request);
    if (options?.method === "PATCH" || (resolveConversationDeletes && options?.method === "DELETE" && url.startsWith("/api/me/conversations/"))) {
      request.reply.resolve(new Response("{}"));
    }
    return request.reply.promise;
  }));
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("studio captured chat command ownership", () => {
  const modelChannels = [{ id: "", name: "平台渠道", creditCost: 5, defaultModel: "gpt-image-2", models: ["gpt-image-2", "seedream-5-5", "h3", "*"] }];

  it("applies Seedream limits after switching from a larger multi-output draft", async () => {
    render(<GeneratorStudio {...baseProps} channels={modelChannels} />);
    expect(screen.queryByRole("option", { name: "h3" })).toBeNull();
    expect(screen.queryByRole("option", { name: "*" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "尺寸" }), { target: { value: "3840x2160" } });
    await userEvent.click(screen.getByRole("button", { name: "高级设置" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "4" }))[0]);
    fireEvent.change(screen.getAllByRole("combobox", { name: "格式" })[0], { target: { value: "webp" } });
    fireEvent.change(screen.getAllByRole("combobox", { name: "模型" })[0], { target: { value: "seedream-5-5" } });
    expect(screen.getByRole("combobox", { name: "尺寸" })).toHaveValue("1824x1024");
    expect(screen.queryByRole("option", { name: /4K/ })).toBeNull();
    expect(screen.queryByRole("option", { name: "WebP" })).toBeNull();
    expect(screen.queryByRole("option", { name: "GIF 动图" })).toBeNull();
    writePrompt("A wide image"); send();
    expect(JSON.parse(String(findRequest("/api/generate").options?.body))).toMatchObject({ model: "seedream-5-5", size: "1824x1024", count: 1, outputFormat: "png" });
  });

  it("limits Seedream uploads and rejects excess references when switching or retrying", () => {
    const failed = generation("seedream_failed", "conversation_a", { status: "failed", model: "seedream-5-5", generationType: "image_to_image", sourceImageUrls: ["/first.png", "/second.png"] });
    render(<GeneratorStudio {...baseProps} channels={modelChannels} initialGenerationPage={page([failed])} />);
    dropFiles("first.png", "second.png");
    fireEvent.change(screen.getByRole("combobox", { name: "模型" }), { target: { value: "seedream-5-5" } });
    writePrompt("Use these images"); send();
    expect(screen.getByRole("alert")).toHaveTextContent("当前模型最多使用 1 张参考图");
    expect(generates()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(generates()).toHaveLength(0);
    expect(within(composer().closest(".composer-silk") as HTMLElement).getAllByAltText("Reference")).toHaveLength(2);
  });

  it("normalizes an old Seedream task on retry without changing the current draft", () => {
    const failed = generation("seedream_failed", "conversation_a", { status: "failed", model: "seedream-5-5", size: "3840x2160", count: 4, outputFormat: "webp" });
    render(<GeneratorStudio {...baseProps} channels={modelChannels} initialGenerationPage={page([failed])} />);
    writePrompt("Keep current draft");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(JSON.parse(String(findRequest("/api/generate").options?.body))).toMatchObject({ model: "seedream-5-5", size: "1824x1024", count: 1, outputFormat: "png" });
    expect(composer()).toHaveValue("Keep current draft");
  });

  it("accepts only one uploaded Seedream reference", () => {
    render(<GeneratorStudio {...baseProps} channels={modelChannels} />);
    fireEvent.change(screen.getByRole("combobox", { name: "模型" }), { target: { value: "seedream-5-5" } });
    dropFiles("first.png", "second.png");
    expect(screen.getByRole("alert")).toHaveTextContent("最多上传 1 张参考图");
    expect(screen.getAllByAltText("Reference")).toHaveLength(1);
    writePrompt("Use this reference"); send();
    const body = findRequest("/api/generate").options?.body as FormData;
    expect(body.getAll("referenceImages")).toHaveLength(1);
    expect(body.get("model")).toBe("seedream-5-5");
  });

  it.each(["text_to_image", "image_to_image"] as const)("retries the original request parameters and references for %s", (generationType) => {
    const failed = generation("failed", "conversation_a", {
      status: "failed", generationType, model: "gpt-image-1", size: "3840x2160",
      count: generationType === "image_to_image" ? 1 : 3, quality: "high", outputFormat: "webp", outputCompression: 82,
      moderation: "low", negativePrompt: "no blur",
      sourceImageUrls: generationType === "image_to_image" ? ["https://example.com/first.png", "https://example.com/second.png"] : [],
    });
    render(<GeneratorStudio {...baseProps} initialGenerationPage={page([failed])} />);
    writePrompt("Keep this newer draft");
    fireEvent.change(screen.getByRole("combobox", { name: "尺寸" }), { target: { value: "1024x1024" } });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    const body = findRequest("/api/generate").options?.body;
    if (generationType === "image_to_image") {
      expect(body).toBeInstanceOf(FormData);
      const form = body as FormData;
      expect(Object.fromEntries(form)).toMatchObject({
        generationType, model: failed.model, size: failed.size, quality: failed.quality,
        prompt: failed.prompt, outputFormat: "webp", outputCompression: "82", moderation: "low",
        replaceGenerationId: failed.id, conversationId: "conversation_a", providerMode: "built_in",
      });
      expect(form.getAll("referenceImageUrls")).toEqual(failed.sourceImageUrls);
    } else {
      expect(JSON.parse(String(body))).toMatchObject({
        generationType, model: failed.model, size: failed.size, quality: failed.quality,
        prompt: failed.prompt, count: 3, outputFormat: "webp", outputCompression: 82, moderation: "low",
        negativePrompt: "no blur", replaceGenerationId: failed.id, conversationId: "conversation_a", providerMode: "built_in",
      });
    }
    expect(composer()).toHaveValue("Keep this newer draft");
  });

  it("shows lost references instead of retrying an image edit as text", () => {
    const failed = generation("failed", "conversation_a", { status: "failed", generationType: "image_to_image" });
    render(<GeneratorStudio {...baseProps} initialGenerationPage={page([failed])} />);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByRole("alert")).toHaveTextContent("原任务的参考图已不可用，请重新添加参考图后生成");
    expect(generates()).toHaveLength(0);
  });

  it("keeps the original custom provider mode when retrying from site mode", () => {
    const failed = generation("failed", "conversation_a", { status: "failed", providerMode: "custom", model: "original-model" });
    render(<GeneratorStudio {...baseProps} initialGenerationPage={page([failed])}
      savedProvider={{ id: "saved", baseUrl: "https://custom.example/v1", model: "current-model", models: ["current-model", "original-model"], label: "My API", updatedAt: "2026-10-01T00:00:00.000Z" }} />);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(JSON.parse(String(findRequest("/api/generate").options?.body))).toMatchObject({ providerMode: "custom", model: "original-model" });
  });

  it("allows text generation after switching from a conversation with references", () => {
    render(<GeneratorStudio {...baseProps} />);
    dropFiles("old-reference.png");
    selectChat("Chat B");
    writePrompt("A new text request"); send();
    expect(JSON.parse(String(findRequest("/api/generate").options?.body))).toMatchObject({ generationType: "text_to_image", conversationId: "conversation_b" });
    expect(screen.queryByAltText("Reference")).toBeNull();
  });

  it("does not submit short prompts with or without reference images", () => {
    render(<GeneratorStudio {...baseProps} />);
    for (const withReference of [false, true]) {
      if (withReference) dropFiles("reference.png");
      for (const prompt of ["", " ", "画"]) {
        writePrompt(prompt);
        expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
        fireEvent.keyDown(composer(), { key: "Enter" });
        send();
      }
    }
    expect(generates()).toHaveLength(0);
  });

  it.each(["new", "switch", "delete", "owner"])("never appends/selects/submits a delayed provisional create after %s", async (operation) => {
    const { rerender } = render(<GeneratorStudio {...baseProps} />);
    newChat();
    writePrompt("Captured old draft");
    dropFiles("old.png");
    send();
    const create = findRequest("/api/me/conversations");
    if (operation === "new") newChat();
    if (operation === "switch") selectChat("Chat B");
    if (operation === "delete") fireEvent.click(screen.getByRole("button", { name: "删除会话 Chat B" }));
    if (operation === "owner") rerender(<GeneratorStudio {...baseProps} ownerId="owner_b" />);
    writePrompt("Latest live draft");
    await reply(create, created());
    expect(create.options?.signal?.aborted).toBe(true);
    expect(generates()).toEqual([]);
    expect(composer()).toHaveValue("Latest live draft");
    expect(within(navigation()).queryByText("Captured create")).toBeNull();
    expect(screen.queryByAltText("Reference")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:old.png");
  });

  it("can submit the new draft while an obsolete create is still unresolved", async () => {
    render(<GeneratorStudio {...baseProps} />);
    newChat(); writePrompt("Obsolete command"); send();
    const obsolete = findRequest("/api/me/conversations");
    newChat(); writePrompt("Current command"); send();
    const current = requests.filter((item) => item.url === "/api/me/conversations")[1];
    await reply(current, created("current_chat"));
    expect(generates()).toHaveLength(1);
    expect(JSON.parse(String(generates()[0].options?.body))).toMatchObject({ conversationId: "current_chat", prompt: "Current command" });
    await reply(obsolete, created("obsolete_chat"));
    expect(generates()).toHaveLength(1);
    expect(preferences.get("narra_active_conversation_id:owner_a")).toBe("current_chat");
  });

  it("does not restore old reference inputs over edits made while conversation creation fails", async () => {
    render(<GeneratorStudio {...baseProps} />);
    newChat(); writePrompt("Old prompt"); dropFiles("old-a.png", "old-b.png"); send();
    writePrompt("Replacement draft"); dropFiles("new.png");
    await reply(findRequest("/api/me/conversations"), { error: "Failed create" }, 503);
    expect(composer()).toHaveValue("Replacement draft");
    expect(screen.getAllByAltText("Reference").map((image) => image.getAttribute("src"))).toEqual(["blob:new.png"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(generates()).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:old-a.png");
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:new.png");
  });

  it("restores the draft without generating when a new-session response has a non-renderable title", async () => {
    render(<GeneratorStudio {...baseProps} />);
    newChat(); writePrompt("Preserved create input"); dropFiles("original.png"); send();
    await reply(findRequest("/api/me/conversations"), { data: { conversation: {
      ...created().data.conversation, title: { unexpected: "object" },
    } } });
    expect(composer()).toHaveValue("Preserved create input");
    expect(screen.getByAltText("Reference")).toHaveAttribute("src", "blob:original.png");
    expect(screen.getByRole("alert")).toHaveTextContent("创建会话失败");
    expect(generates()).toEqual([]);
    expect(within(navigation()).queryByText("Captured create")).toBeNull();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:original.png");
  });

  it.each(["typed-then-cleared", "switched-back"])("rejects a late generation error after the draft was %s", async (operation) => {
    render(<GeneratorStudio {...baseProps} />);
    writePrompt("Submitted old prompt"); send();
    if (operation === "typed-then-cleared") { writePrompt("New prompt"); writePrompt(""); }
    else { selectChat("Chat B"); selectChat("Chat A"); }
    await reply(findRequest("/api/generate"), { error: "Old generation failure" }, 503);
    expect(composer()).toHaveValue("");
    expect(screen.queryByText("Old generation failure")).toBeNull();
    expect(screen.queryByText("Submitted old prompt")).toBeNull();
  });

  it("freezes reference order, options and CAPTCHA before creating a conversation while preserving newer inputs", async () => {
    render(<GeneratorStudio {...baseProps} turnstile={{ isEnabled: true, siteKey: "test-site", protectGenerate: true }} />);
    newChat(); writePrompt("Frozen image edit"); dropFiles("first.png", "second.png");
    fireEvent.click(screen.getByRole("button", { name: "参考图 2 前移" }));
    fireEvent.change(screen.getByRole("combobox", { name: "尺寸" }), { target: { value: "1024x1024" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify first" }));
    send();
    writePrompt("Next image edit"); dropFiles("next.png");
    fireEvent.change(screen.getByRole("combobox", { name: "尺寸" }), { target: { value: "2048x2048" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify next" }));
    await reply(findRequest("/api/me/conversations"), created());
    const body = generates()[0].options?.body as FormData;
    expect(body.get("conversationId")).toBe("created_chat");
    expect(body.get("prompt")).toBe("Frozen image edit");
    expect(body.get("size")).toBe("1024x1024");
    expect(body.get("turnstileToken")).toBe("first-token");
    expect(body.getAll("referenceImages").map((value) => (value as File).name)).toEqual(["second.png", "first.png"]);
    await reply(generates()[0], { data: { generation: generation("accepted", "created_chat") } });
    expect(composer()).toHaveValue("Next image edit");
    expect(screen.getByAltText("Reference")).toHaveAttribute("src", "blob:next.png");
    expect(screen.getByRole("combobox", { name: "尺寸" })).toHaveValue("2048x2048");
    expect(challenge.reset).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
    send();
    expect((generates()[1].options?.body as FormData).get("turnstileToken")).toBe("next-token");
  });

  it("prevents button/Enter double-submission even after typing a second prompt during the pending command", async () => {
    render(<GeneratorStudio {...baseProps} />);
    writePrompt("First command"); send();
    writePrompt("Second draft");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.keyDown(composer(), { key: "Enter" });
    fireEvent.keyDown(composer(), { key: "Enter" });
    send();
    expect(generates()).toHaveLength(1);
    await reply(generates()[0], { data: { generation: generation("first_ack") } });
    expect(composer()).toHaveValue("Second draft");
    send();
    expect(generates()).toHaveLength(2);
    expect(JSON.parse(String(generates()[1].options?.body)).prompt).toBe("Second draft");
  });

  it("keeps malformed generation acknowledgements out of the mounted cache and restores the current input", async () => {
    vi.useFakeTimers();
    render(<GeneratorStudio {...baseProps} />);
    writePrompt("Recoverable submitted prompt"); send();
    await reply(generates()[0], { data: { generation: { ...generation("invalid_ack"), images: [null] } } });
    expect(composer()).toHaveValue("Recoverable submitted prompt");
    expect(screen.getByRole("alert")).toHaveTextContent("服务端返回的生成内容不正确");
    expect(screen.queryByText("prompt invalid_ack")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(requests).toHaveLength(1);
  });

  it("resets drafts/previews/provider runtime and drops late commands on the actual A-B-A owner cycle", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<GeneratorStudio {...baseProps} />);
    await user.click(screen.getByRole("button", { name: "高级设置" }));
    await user.click(screen.getAllByRole("button", { name: "自填 API" })[0]);
    fireEvent.change(screen.getAllByLabelText("第三方 API Key")[0], { target: { value: "fixture-only-key" } });
    await user.click(screen.getAllByRole("button", { name: "拉取模型" })[0]);
    const probe = findRequest("/api/provider-models/probe");
    writePrompt("Owner A request"); dropFiles("owner-a.png"); send();
    const submitted = findRequest("/api/generate");
    rerender(<GeneratorStudio {...baseProps} ownerId="owner_b" />);
    expect(composer()).toHaveValue("");
    expect(screen.queryByAltText("Reference")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:owner-a.png");
    expect(probe.options?.signal?.aborted).toBe(true);
    expect(submitted.options?.signal?.aborted).toBe(true);
    rerender(<GeneratorStudio {...baseProps} />);
    writePrompt("Fresh owner A draft");
    await reply(submitted, { data: { generation: generation("obsolete_ack") } });
    await reply(probe, { data: { models: ["obsolete-model"] } });
    expect(composer()).toHaveValue("Fresh owner A draft");
    expect(screen.queryByText("prompt obsolete_ack")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "高级设置" }));
    await user.click(screen.getAllByRole("button", { name: "自填 API" })[0]);
    expect(screen.getAllByLabelText("第三方 API Key")[0]).toHaveValue("");
    expect(screen.getAllByLabelText("第三方模型")[0]).toHaveValue("gpt-image-2");
    expect(screen.queryByText("已拉取 1 个模型")).toBeNull();
  });

  it("keeps local prompt, references, selection and provider input on same-owner fresh props", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<GeneratorStudio {...baseProps} />);
    selectChat("Chat B"); writePrompt("Local draft"); dropFiles("local.png");
    await user.click(screen.getByRole("button", { name: "高级设置" }));
    await user.click(screen.getAllByRole("button", { name: "自填 API" })[0]);
    fireEvent.change(screen.getAllByLabelText("第三方 API Key")[0], { target: { value: "local-fixture-key" } });
    rerender(<GeneratorStudio {...baseProps} currentUser={{ credits: 999, role: "user" }} initialPrompt="Stale server prompt" initialConversations={[...baseProps.initialConversations!]} initialGenerationPage={page([generation("stale_job")])} />);
    expect(composer()).toHaveValue("Local draft");
    expect(screen.getByAltText("Reference")).toHaveAttribute("src", "blob:local.png");
    expect(screen.getAllByLabelText("第三方 API Key")[0]).toHaveValue("local-fixture-key");
    expect(preferences.get("narra_active_conversation_id:owner_a")).toBe("conversation_b");
    expect(screen.queryByText("prompt stale_job")).toBeNull();
    expect(requests).toEqual([]);
  });

  it("keeps a known A job polling while B is selected and never regresses terminal data from fresh props", async () => {
    vi.useFakeTimers();
    const pending = generation("pending_a", "conversation_a", { status: "pending" });
    const props = { ...baseProps, initialConversations: [summary("conversation_a", "Chat A", 1), summary("conversation_b", "Chat B")], initialGenerationPage: page([pending]) };
    const { rerender } = render(<GeneratorStudio {...props} />);
    selectChat("Chat B"); writePrompt("B stays local");
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0]); });
    const poll = findRequest("/api/me/generations/pending_a", "GET");
    await reply(poll, { data: { generation: generation("pending_a", "conversation_a", { prompt: "Canonical terminal A" }) } });
    expect(composer()).toHaveValue("B stays local");
    expect(screen.queryByText("Canonical terminal A")).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    rerender(<GeneratorStudio {...props} initialGenerationPage={page([{ ...pending }])} />);
    expect(composer()).toHaveValue("B stays local");
    selectChat("Chat A");
    expect(screen.getByText("Canonical terminal A")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消生成" })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(requests.filter((item) => item.url === poll.url)).toHaveLength(1);
  });

  it("converges the visible cache and poll registry when terminal time is behind the pending timestamp", async () => {
    vi.useFakeTimers();
    const pending = generation("clock_skew", "conversation_a", { status: "pending", updatedAt: "2026-10-03T00:00:00.000Z" });
    render(<GeneratorStudio {...baseProps} initialGenerationPage={page([pending])} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0]); });
    await reply(findRequest("/api/me/generations/clock_skew", "GET"), { data: { generation: generation("clock_skew", "conversation_a", {
      updatedAt: "2026-10-02T00:00:00.000Z", prompt: "Terminal without a render loop",
    }) } });
    expect(screen.getByText("Terminal without a render loop")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消生成" })).toBeNull();
    expect(router.refresh).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(requests).toHaveLength(1);
  });

  it("rejects a mismatched cancellation reply and keeps the original job subscribed", async () => {
    vi.useFakeTimers();
    const pending = generation("cancel_target", "conversation_a", { status: "pending" });
    render(<GeneratorStudio {...baseProps} initialGenerationPage={page([pending])} />);
    fireEvent.click(screen.getByRole("button", { name: "取消生成" }));
    await reply(findRequest("/api/me/generations/cancel_target", "DELETE"), { data: { generation: generation("wrong_target") } });
    expect(screen.getByRole("alert")).toHaveTextContent("服务端返回的任务状态不正确");
    expect(screen.getByRole("button", { name: "取消生成" })).toBeInTheDocument();
    expect(screen.queryByText("prompt wrong_target")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0]); });
    await reply(findRequest("/api/me/generations/cancel_target", "GET"), { data: { generation: generation("cancel_target", "conversation_a", { status: "failed" }) } });
    expect(screen.queryByRole("button", { name: "取消生成" })).toBeNull();
  });

  it("retains polling of an accepted deleted-origin job without restoring its organization or cancelling it", async () => {
    vi.useFakeTimers();
    render(<GeneratorStudio {...baseProps} />);
    writePrompt("Removed source request"); send();
    fireEvent.click(screen.getByRole("button", { name: "删除会话 Chat A" }));
    await reply(generates()[0], { data: { generation: generation("detached", "conversation_a", { status: "pending" }) } });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0]); });
    await reply(findRequest("/api/me/generations/detached", "GET"), { data: { generation: generation("detached", "conversation_a", { prompt: "Detached terminal" }) } });
    expect(screen.queryByText("Detached terminal")).toBeNull();
    expect(within(navigation()).queryByText("Chat A")).toBeNull();
    expect(screen.getByText("你好，你想创作什么？")).toBeInTheDocument();
    expect(requests.filter((item) => item.url.includes("/generations/") && item.options?.method === "DELETE")).toEqual([]);
    expect(generates()).toHaveLength(1);
  });

  it.each([
    ["append", false], ["replace", false], ["append", true], ["replace", true],
  ] as const)("reconciles a buffered %s ACK only if pending deletion fails (deleted=%s)", async (operation, deleted) => {
    vi.useFakeTimers();
    resolveConversationDeletes = false;
    const previous = generation("previous", "conversation_a", { status: operation === "replace" ? "failed" : "pending" });
    render(<GeneratorStudio {...baseProps} initialGenerationPage={page([previous])} initialConversations={[
      summary("conversation_a", "Chat A", 1), summary("conversation_b", "Chat B"),
    ]} />);
    if (operation === "replace") fireEvent.click(screen.getByRole("button", { name: "重试" }));
    else { writePrompt("Accepted while deleting"); send(); }
    fireEvent.click(screen.getByRole("button", { name: "删除会话 Chat A" }));
    const deletion = findRequest("/api/me/conversations/conversation_a", "DELETE");
    writePrompt("New draft stays selected");
    await reply(generates()[0], { data: { generation: generation("buffered", "conversation_a", { status: "pending" }) } });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0]); });
    const completed = generation("buffered", "conversation_a", { images: [{
      id: "buffered_image", url: "https://example.test/buffered.png", actualWidth: 1, actualHeight: 1, actualSize: "1x1",
    }] });
    await reply(findRequest("/api/me/generations/buffered", "GET"), { data: { generation: completed } });
    if (operation === "append") {
      await reply(findRequest("/api/me/generations/previous", "GET"), { data: { generation: generation("previous", "conversation_a", { images: [{
        id: "previous_image", url: "https://example.test/previous.png", actualWidth: 1, actualHeight: 1, actualSize: "1x1",
      }] }) } });
    }
    expect(screen.queryByText("prompt buffered")).toBeNull();
    expect(screen.queryByAltText("生成结果")).toBeNull();
    await reply(deletion, deleted ? { data: { ok: true } } : { error: "Temporary failure" }, deleted ? 200 : 503);
    expect(composer()).toHaveValue("New draft stays selected");
    expect(screen.queryByText("prompt buffered")).toBeNull();
    if (deleted) {
      expect(within(navigation()).queryByText("Chat A")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    } else {
      expect(screen.getByRole("alert")).toHaveTextContent("删除会话失败");
      selectChat("Chat A");
      expect(screen.getByText("prompt buffered")).toBeInTheDocument();
      const images = screen.getAllByAltText("生成结果");
      expect(images).toHaveLength(operation === "append" ? 2 : 1);
      expect(images.some((image) => image.getAttribute("src")?.includes("buffered.png"))).toBe(true);
      expect(screen.queryByRole("button", { name: "取消生成" })).toBeNull();
      expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
      expect(within(navigation()).getByText(new RegExp(`${operation === "append" ? 2 : 1} 轮`))).toBeInTheDocument();
      expect(screen.queryByText("prompt previous") !== null).toBe(operation === "append");
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(generates()).toHaveLength(1);
    expect(requests.filter((item) => item.url.includes("/generations/") && item.options?.method === "DELETE")).toEqual([]);
    expect(requests.filter((item) => item.url.includes("/conversations/") && item.options?.method !== "DELETE")).toEqual([]);
  });

  it("reopens an owner with a fresh canonical cache and ignores its previous mount's late poll", async () => {
    vi.useFakeTimers();
    const pending = generation("same_job", "conversation_a", { status: "pending" });
    const props = { ...baseProps, initialGenerationPage: page([pending]) };
    const { rerender } = render(<GeneratorStudio {...props} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0]); });
    const oldPoll = findRequest("/api/me/generations/same_job", "GET");
    rerender(<GeneratorStudio {...baseProps} ownerId="owner_b" />);
    expect(oldPoll.options?.signal?.aborted).toBe(true);
    expect(screen.queryByText("prompt same_job")).toBeNull();
    rerender(<GeneratorStudio {...props} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0]); });
    const currentPoll = requests.filter((item) => item.url === oldPoll.url)[1];
    await reply(oldPoll, { data: { generation: generation("same_job", "conversation_a", { prompt: "Old owner cache" }) } });
    expect(screen.queryByText("Old owner cache")).toBeNull();
    expect(screen.getByRole("button", { name: "取消生成" })).toBeInTheDocument();
    expect(router.refresh).not.toHaveBeenCalled();
    await reply(currentPoll, { data: { generation: generation("same_job", "conversation_a", { prompt: "Current owner cache" }) } });
    expect(screen.getByText("Current owner cache")).toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([200, 503])("ignores old cancellation and conversation-delete replies after owner A-B-A (delete status %s)", async (status) => {
    resolveConversationDeletes = false;
    const pending = generation("old_command", "conversation_a", { status: "pending" });
    const props = { ...baseProps, initialGenerationPage: page([pending]) };
    const { rerender } = render(<GeneratorStudio {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "取消生成" }));
    const cancel = findRequest("/api/me/generations/old_command", "DELETE");
    fireEvent.click(screen.getByRole("button", { name: "删除会话 Chat A" }));
    const deletion = findRequest("/api/me/conversations/conversation_a", "DELETE");
    rerender(<GeneratorStudio {...baseProps} ownerId="owner_b" />);
    rerender(<GeneratorStudio {...props} />);
    writePrompt("Fresh account draft");
    await reply(cancel, { data: { generation: generation("old_command", "conversation_a", { status: "failed" }) } });
    await reply(deletion, {}, status);
    expect(cancel.options?.signal?.aborted).toBe(true);
    expect(deletion.options?.signal?.aborted).toBe(true);
    expect(composer()).toHaveValue("Fresh account draft");
    expect(screen.getByRole("button", { name: "取消生成" })).toBeInTheDocument();
    expect(within(navigation()).getByText("Chat A")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(generates()).toEqual([]);
  });

  it("hands a site image to the browser at the click, so nothing can finish late after an owner change", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const image = generation("image", "conversation_a", { images: [{ id: "image", url: "https://example.test/owned.png", actualWidth: 1, actualHeight: 1, actualSize: "1x1" }] });
    const { rerender } = render(<GeneratorStudio {...baseProps} initialGenerationPage={page([image])} />);
    fireEvent.click(screen.getByTitle("下载保存"));
    const download = new URL((click.mock.contexts[0] as HTMLAnchorElement).href);
    expect(download.pathname).toBe("/api/proxy-image");
    expect(download.searchParams.get("url")).toBe("https://example.test/owned.png");
    expect(download.searchParams.get("download")).toMatch(/^\d{2}-\d{2}-\d{2}-\d{2}$/);
    expect(requests).toEqual([]);
    rerender(<GeneratorStudio {...baseProps} ownerId="owner_b" />);
    expect(click).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByAltText("生成结果")).toBeNull());
  });
});
