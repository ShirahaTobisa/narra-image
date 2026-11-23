import { beforeEach, describe, expect, it, vi } from "vitest";

import { canvasPng } from "./helpers/canvas-api-fixtures";

const { mockEnv } = vi.hoisted(() => ({ mockEnv: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getEnv: mockEnv }));

import { precheckGeneration } from "@/lib/moderation/precheck";

const configured = { PRECHECK_API_KEY: "key", PRECHECK_BASE_URL: "https://relay.invalid/v1/", PRECHECK_MODEL: "flash", PRECHECK_TIMEOUT_MS: 15_000 };
const answer = (content: string, ok = true) => ({ json: async () => ({ choices: [{ message: { content } }] }), ok, status: ok ? 200 : 500 });
const sentBody = () => JSON.parse(String((vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit])[1].body));

describe("预审 precheckGeneration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockEnv.mockReturnValue(configured);
    global.fetch = vi.fn();
  });

  it("没配齐就不问，直接放行", async () => {
    mockEnv.mockReturnValue({ ...configured, PRECHECK_MODEL: "" });
    await expect(precheckGeneration("a cat", [])).resolves.toEqual({ refuse: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("文生图只送文字，不限输出长度；判定会拒时带回理由", async () => {
    vi.mocked(global.fetch).mockResolvedValue(answer('```json\n{"refuse": true, "reason": "年龄不明角色擦边"}\n```') as Response);
    await expect(precheckGeneration("a school girl", [])).resolves.toEqual({ model: "flash", reason: "年龄不明角色擦边", refuse: true });
    expect(vi.mocked(global.fetch).mock.calls[0][0]).toBe("https://relay.invalid/v1/chat/completions");
    const body = sentBody();
    expect(body).toMatchObject({ model: "flash", temperature: 0 });
    expect(body).not.toHaveProperty("max_tokens");
    expect(body.messages[1]).toEqual({ content: "a school girl", role: "user" });
  });

  it("图生图把参考图缩小成 JPEG 一起送，最多 4 张", async () => {
    vi.mocked(global.fetch).mockResolvedValue(answer('{"refuse": false, "reason": "正常"}') as Response);
    const image = { data: canvasPng(), mimeType: "image/png" };
    await expect(precheckGeneration("make it a painting", [image, image, image, image, image])).resolves.toEqual({ refuse: false });
    const parts = sentBody().messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.map((part) => part.type)).toEqual(["text", "image_url", "image_url", "image_url", "image_url"]);
    expect(parts[1].image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it.each([
    ["接口报错", () => Promise.resolve(answer("", false) as Response)],
    ["回的不是 JSON", () => Promise.resolve(answer("我觉得没问题") as Response)],
    ["超时或断开", () => Promise.reject(new Error("timeout"))],
  ])("%s时放行", async (_label, reply) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(global.fetch).mockImplementation(reply);
    await expect(precheckGeneration("a cat", [])).resolves.toEqual({ refuse: false });
  });
});
