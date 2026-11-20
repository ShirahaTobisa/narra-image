import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockResolveConfig, mockMatchWords } = vi.hoisted(() => {
  const contentReview = { create: vi.fn() };
  const generationJob = { count: vi.fn() };
  const resolveConfig = vi.fn();
  const matchWords = vi.fn();
  return {
    mockDb: { contentReview, generationJob },
    mockMatchWords: matchWords,
    mockResolveConfig: resolveConfig,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/moderation/config", () => ({
  resolveModerationConfig: mockResolveConfig,
}));
vi.mock("@/lib/moderation/sensitive-words", () => ({
  matchSensitiveWords: mockMatchWords,
}));

import {
  checkGenerationInput,
  MODERATION_UNAVAILABLE_MESSAGE,
  PROVIDER_COOLDOWN_MESSAGE,
} from "@/lib/moderation/check";

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    aiApiKey: null,
    aiBaseUrl: null,
    aiEnabled: false,
    aiModel: "text-moderation-latest",
    aiThreshold: 0.5,
    isEnabled: true,
    sensitiveWordsEnabled: true,
    ...overrides,
  };
}

const aiConfig = () =>
  baseConfig({ aiApiKey: "key", aiBaseUrl: "https://x/v1", aiEnabled: true, aiModel: "omni-moderation-latest" });

function mockModerationResponse(results: unknown[]) {
  global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ results }), ok: true });
}

function sentModerationBody() {
  const [, init] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body)) as { input: unknown; model?: string };
}

describe("内容审核 checkGenerationInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    global.fetch = vi.fn();
    mockMatchWords.mockReturnValue([]);
    mockDb.generationJob.count.mockResolvedValue(0);
  });

  it("审核未启用时直接放行", async () => {
    mockResolveConfig.mockResolvedValue(
      baseConfig({ isEnabled: false }),
    );

    const result = await checkGenerationInput({ prompt: "色情图片", userId: "u1" });

    expect(result.allowed).toBe(true);
    expect(mockMatchWords).not.toHaveBeenCalled();
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it("敏感词命中时阻断并记录", async () => {
    mockResolveConfig.mockResolvedValue(baseConfig());
    mockMatchWords.mockReturnValue([{ category: "NSFW", word: "色情" }]);

    const result = await checkGenerationInput({
      negativePrompt: "no gore",
      prompt: "色情图片",
      userId: "u1",
    });

    expect(result.allowed).toBe(false);
    expect(mockDb.contentReview.create).toHaveBeenCalledWith({
      data: {
        category: "NSFW",
        hitWords: ["色情"],
        kind: "sensitive_word",
        negativePrompt: "no gore",
        prompt: "色情图片",
        userId: "u1",
      },
    });
  });

  it("AI 已配置且判定违规时阻断并记录 ai_moderation", async () => {
    mockResolveConfig.mockResolvedValue(
      baseConfig({ aiApiKey: "key", aiBaseUrl: "https://x/v1", aiEnabled: true }),
    );
    mockModerationResponse([{ category_scores: { sexual: 0.9, hate: 0.1 }, flagged: false }]);

    const result = await checkGenerationInput({ prompt: "some prompt", userId: "u1" });

    expect(result.allowed).toBe(false);
    expect(mockDb.contentReview.create).toHaveBeenCalledWith({
      data: {
        aiModel: "text-moderation-latest",
        aiScore: 0.9,
        category: "sexual",
        kind: "ai_moderation",
        negativePrompt: null,
        prompt: "some prompt",
        userId: "u1",
      },
    });
  });

  it("AI 判定通过时放行", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([{ category_scores: { sexual: 0.1 }, flagged: false }]);

    const result = await checkGenerationInput({ prompt: "a cute cat", userId: "u1" });

    expect(result.allowed).toBe(true);
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it("AI 审核异常时拒绝本次生成（不放行、不当违规记录）", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    global.fetch = vi.fn().mockRejectedValue(new Error("timeout"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await checkGenerationInput({ prompt: "ok prompt", userId: "u1" });

    expect(result).toEqual({ allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE });
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("审核接口返回空结果时拒绝，不当成通过", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await checkGenerationInput({ prompt: "ok prompt", userId: "u1" });

    expect(result).toEqual({ allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE });
  });

  it.each([
    {},
    { flagged: false },
    { flagged: "false", category_scores: { sexual: 0.1 } },
    { flagged: false, category_scores: {} },
    { flagged: false, category_scores: { sexual: "unknown" } },
    { flagged: false, category_scores: { sexual: -0.1 } },
    { flagged: false, category_scores: { sexual: 1.1 } },
  ])("审核结果结构或分数无效时拒绝，而不是放行：%j", async (invalid) => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([invalid]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await checkGenerationInput({ prompt: "a cat", userId: "u1" })).toEqual({
      allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE,
    });
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it("AI 审核已开启但没配接口地址或密钥时拒绝（不调用接口）", async () => {
    mockResolveConfig.mockResolvedValue(
      baseConfig({ aiApiKey: null, aiBaseUrl: null, aiEnabled: true }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await checkGenerationInput({ prompt: "ok prompt", userId: "u1" });

    expect(result).toEqual({ allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("参考图和提示词一起送审", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([{ category_scores: { sexual: 0.01 }, flagged: false }]);

    const result = await checkGenerationInput({
      images: [{ data: Buffer.from("png"), mimeType: "image/png" }],
      prompt: "make it blue",
      userId: "u1",
    });

    expect(result.allowed).toBe(true);
    expect(sentModerationBody()).toEqual({
      input: [
        { text: "make it blue", type: "text" },
        { image_url: { url: "data:image/png;base64,cG5n" }, type: "image_url" },
      ],
      model: "omni-moderation-latest",
    });
  });

  it("只有参考图、没有提示词时也会审图", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([{ category_scores: { sexual: 0.97 }, flagged: true }]);

    const result = await checkGenerationInput({
      images: [{ data: Buffer.from("png"), mimeType: "image/png" }],
      prompt: "",
      userId: "u1",
    });

    expect(result.allowed).toBe(false);
    expect(sentModerationBody().input).toEqual([
      { image_url: { url: "data:image/png;base64,cG5n" }, type: "image_url" },
    ]);
  });

  it("涉及未成年人的分数超过 0.02 就拒，即使没标记、也低于通用阈值", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([
      { category_scores: { sexual: 0.2, "sexual/minors": 0.03 }, flagged: false },
    ]);

    const result = await checkGenerationInput({ prompt: "borderline", userId: "u1" });

    expect(result.allowed).toBe(false);
    expect(mockDb.contentReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ aiScore: 0.03, category: "sexual/minors" }),
    });
  });

  it("站内渠道 24 小时内被上游拦截达到 3 次时暂停，不再送审", async () => {
    mockDb.generationJob.count.mockResolvedValue(3);

    const result = await checkGenerationInput({ builtIn: true, prompt: "a cat", userId: "u1" });

    expect(result).toEqual({ allowed: false, message: PROVIDER_COOLDOWN_MESSAGE });
    expect(mockDb.generationJob.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ providerMode: "BUILT_IN", status: "FAILED", userId: "u1" }),
    });
    expect(mockResolveConfig).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("站内渠道拦截次数未到上限时照常审核；自填渠道不查拦截次数", async () => {
    mockResolveConfig.mockResolvedValue(baseConfig({ isEnabled: false }));
    mockDb.generationJob.count.mockResolvedValue(2);

    await expect(
      checkGenerationInput({ builtIn: true, prompt: "a cat", userId: "u1" }),
    ).resolves.toEqual({ allowed: true });
    expect(mockDb.generationJob.count).toHaveBeenCalledTimes(1);

    await expect(
      checkGenerationInput({ builtIn: false, prompt: "a cat", userId: "u1" }),
    ).resolves.toEqual({ allowed: true });
    expect(mockDb.generationJob.count).toHaveBeenCalledTimes(1);
  });

  it("均未命中时放行且不记录", async () => {
    mockResolveConfig.mockResolvedValue(baseConfig());

    const result = await checkGenerationInput({ prompt: "a cute cat", userId: "u1" });

    expect(result.allowed).toBe(true);
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });
});
