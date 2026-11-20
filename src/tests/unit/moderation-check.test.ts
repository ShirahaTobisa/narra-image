import { beforeEach, describe, expect, it, vi } from "vitest";
import { canvasPng } from "./helpers/canvas-api-fixtures";

const { mockDb, mockResolveConfig, mockMatchWords, mockCheckLocalImages } = vi.hoisted(() => {
  const contentReview = { create: vi.fn() };
  const generationJob = { count: vi.fn() };
  const resolveConfig = vi.fn();
  const matchWords = vi.fn();
  return {
    mockDb: { contentReview, generationJob },
    mockCheckLocalImages: vi.fn(),
    mockMatchWords: matchWords,
    mockResolveConfig: resolveConfig,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/moderation/config", () => ({
  resolveModerationConfig: mockResolveConfig,
}));
vi.mock("@/lib/moderation/local-images", () => ({
  checkLocalImages: mockCheckLocalImages,
  LOCAL_IMAGE_MODEL: "nsfwjs/MobileNetV2Mid@4.4.0",
}));
vi.mock("@/lib/moderation/sensitive-words", () => ({
  matchSensitiveWords: mockMatchWords,
}));

import {
  checkGenerationInput,
  MODERATION_BLOCK_MESSAGE,
  MODERATION_UNAVAILABLE_MESSAGE,
  PROVIDER_COOLDOWN_MESSAGE,
} from "@/lib/moderation/check";
import { LOCAL_IMAGE_MODEL } from "@/lib/moderation/local-images";

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

const pngBase64 = canvasPng().toString("base64");
const pngImage = () => ({ data: Buffer.from(pngBase64, "base64"), mimeType: "image/png" });

function moderationResult(overrides: Record<string, unknown> = {}) {
  return {
    categories: { sexual: false, "sexual/minors": false, hate: false },
    category_scores: { sexual: 0.01, "sexual/minors": 0, hate: 0 },
    category_applied_input_types: { sexual: ["text", "image"], "sexual/minors": ["text"], hate: ["text"] },
    flagged: false,
    ...overrides,
  };
}

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
    mockCheckLocalImages.mockReset().mockResolvedValue({ blocked: false });
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
    mockModerationResponse([moderationResult({ category_scores: { sexual: 0.9, "sexual/minors": 0, hate: 0.1 } })]);

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
    mockModerationResponse([moderationResult({
      category_applied_input_types: { sexual: ["text"], "sexual/minors": ["text"] },
    })]);

    const result = await checkGenerationInput({ prompt: "a cute cat", userId: "u1" });

    expect(result.allowed).toBe(true);
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it("AI 审核异常时拒绝本次生成（不放行、不当违规记录）", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    global.fetch = vi.fn().mockRejectedValue(new Error("Bearer secret-key https://private-host/ user-content"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await checkGenerationInput({ prompt: "ok prompt", userId: "u1" });

    expect(result).toEqual({ allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE });
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(/secret-key|private-host|user-content/);
    expect(errorSpy.mock.calls.flat().every((value) => typeof value === "string")).toBe(true);
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
    moderationResult({ category_scores: { hate: 0 } }),
    moderationResult({ category_scores: { sexual: 0.01 } }),
    moderationResult({ category_scores: { "sexual/minors": 0 } }),
    moderationResult({ categories: undefined }),
    moderationResult({ categories: { hate: false } }),
    moderationResult({ categories: { sexual: false } }),
    moderationResult({ categories: { sexual: "false", "sexual/minors": false } }),
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
    mockModerationResponse([moderationResult()]);

    const result = await checkGenerationInput({
      builtIn: true,
      images: [pngImage()],
      prompt: "make it blue",
      userId: "u1",
    });

    expect(result.allowed).toBe(true);
    expect(sentModerationBody()).toEqual({
      input: [
        { text: "make it blue", type: "text" },
        { image_url: { url: `data:image/png;base64,${pngBase64}` }, type: "image_url" },
      ],
      model: "omni-moderation-latest",
    });
  });

  it("纯文本不启动本机图片检查", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult()]);
    mockCheckLocalImages.mockRejectedValue(new Error("本机图片模型不可用"));

    expect(await checkGenerationInput({ builtIn: true, prompt: "a blue landscape", userId: "u1" })).toEqual({ allowed: true });
    expect(mockCheckLocalImages).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it("本机拒绝图片时不发送远程请求，并记录实际本机模型", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult()]);
    mockCheckLocalImages.mockResolvedValue({ blocked: true, category: "sexual", score: 0.81, model: LOCAL_IMAGE_MODEL });

    expect(await checkGenerationInput({
      builtIn: true, prompt: "a blue landscape", negativePrompt: "avoid blur", images: [pngImage()], userId: "u1",
    })).toEqual({ allowed: false, message: MODERATION_BLOCK_MESSAGE });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDb.contentReview.create).toHaveBeenCalledWith({ data: {
      aiModel: LOCAL_IMAGE_MODEL, aiScore: 0.81, category: "sexual", kind: "ai_moderation",
      prompt: "a blue landscape", negativePrompt: "avoid blur", userId: "u1",
    } });
  });

  it("本机检查失败时不请求远程服务，也不记录用户违规", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult()]);
    mockCheckLocalImages.mockRejectedValue(new Error("private image details"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await checkGenerationInput({ builtIn: true, images: [pngImage()], userId: "u1" })).toEqual({
      allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("private image details");
  });

  it("等待全部 16 张原图通过本机检查后才按原字节顺序送审", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult()]);
    const images = Array.from({ length: 16 }, (_, index) => ({ data: canvasPng(index), mimeType: "image/png" }));
    const originalBytes = images.map((image) => Buffer.from(image.data));
    let allow!: (value: { blocked: false }) => void;
    mockCheckLocalImages.mockReturnValue(new Promise<{ blocked: false }>((resolve) => { allow = resolve; }));

    const pending = checkGenerationInput({ builtIn: true, prompt: "a blue landscape", images, userId: "u1" });
    await vi.waitFor(() => expect(mockCheckLocalImages).toHaveBeenCalledOnce());
    expect(mockCheckLocalImages.mock.calls[0][0]).toBe(images);
    expect(global.fetch).not.toHaveBeenCalled();
    allow({ blocked: false });

    expect(await pending).toEqual({ allowed: true });
    expect(images.map((image) => image.data)).toEqual(originalBytes);
    expect(sentModerationBody().input).toEqual([
      { type: "text", text: "a blue landscape" },
      ...originalBytes.map((bytes) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` } })),
    ]);
  });

  it("本机通过后仍执行远程审核，远程拒绝记录远程模型", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult({ category_scores: { sexual: 0.9, "sexual/minors": 0 }, flagged: true })]);

    expect(await checkGenerationInput({ builtIn: true, prompt: "a blue landscape", images: [pngImage()], userId: "u1" })).toEqual({
      allowed: false, message: MODERATION_BLOCK_MESSAGE,
    });
    expect(mockCheckLocalImages).toHaveBeenCalledOnce();
    expect(global.fetch).toHaveBeenCalledOnce();
    expect(mockDb.contentReview.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      aiModel: "omni-moderation-latest", category: "sexual", aiScore: 0.9,
    }) });
  });

  it("只有参考图、没有提示词时也会审图", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult({
      category_scores: { sexual: 0.97, "sexual/minors": 0 },
      category_applied_input_types: { sexual: ["image"], "sexual/minors": [] },
      flagged: true,
    })]);

    const result = await checkGenerationInput({
      builtIn: true,
      images: [pngImage()],
      prompt: "",
      userId: "u1",
    });

    expect(result.allowed).toBe(false);
    expect(sentModerationBody().input).toEqual([
      { image_url: { url: `data:image/png;base64,${pngBase64}` }, type: "image_url" },
    ]);
  });

  it("涉及未成年人的分数超过 0.02 就拒，即使没标记、也低于通用阈值", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([
      moderationResult({ category_scores: { sexual: 0.2, "sexual/minors": 0.03 } }),
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
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult()]);
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

  it.each([
    { isEnabled: false },
    { aiEnabled: false },
    { aiApiKey: null },
    { aiApiKey: "   " },
    { aiBaseUrl: null },
    { aiBaseUrl: "not-a-url" },
    { aiBaseUrl: "file:///tmp/moderation" },
    { aiModel: null },
    { aiModel: "   " },
    { aiThreshold: Number.NaN },
    { aiThreshold: 2 },
  ])("站内渠道配置不完整时拒绝，不能只靠关键词：%j", async (overrides) => {
    mockResolveConfig.mockResolvedValue({ ...aiConfig(), ...overrides });
    mockModerationResponse([moderationResult()]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await checkGenerationInput({ builtIn: true, prompt: "a cat", userId: "u1" })).toEqual({
      allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it("配置读取或解密失败时返回审核不可用，不泄漏错误详情", async () => {
    mockResolveConfig.mockRejectedValue(new Error("decrypt secret-key private-db-url"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(checkGenerationInput({ builtIn: true, prompt: "a cat", userId: "u1" })).resolves.toEqual({
      allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(/secret-key|private-db-url/);
    expect(errorSpy.mock.calls.flat().every((value) => typeof value === "string")).toBe(true);
  });

  it.each([
    { label: "只有负面提示词", prompt: "" },
    { label: "长正面提示词", prompt: "a cat".repeat(12_000) },
  ])("负面提示词以排除内容标签完整送审：$label", async ({ prompt }) => {
    const negativePrompt = "avoid blur ".repeat(90);
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult()]);

    expect(await checkGenerationInput({ builtIn: true, prompt, negativePrompt, userId: "u1" })).toEqual({ allowed: true });
    expect(sentModerationBody().input).toBe(`Prompt:\n${prompt}\n\nNegative prompt (content to avoid):\n${negativePrompt}`);
  });

  it("站内没有任何可送审文本或图片时不放行", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkGenerationInput({ builtIn: true, userId: "u1" })).toEqual({
      allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { sexual: ["text"], "sexual/minors": ["text"] },
    { sexual: ["image"], "sexual/minors": ["text"] },
  ])("图文请求缺少 sexual 实际图片/文本覆盖时拒绝：%j", async (coverage) => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult({ category_applied_input_types: coverage })]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await checkGenerationInput({ builtIn: true, prompt: "a cat", images: [pngImage()], userId: "u1" })).toEqual({
      allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE,
    });
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it("纯图片响应 sexual 覆盖 image 即可，不要求 minors 支持图片", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult({
      category_applied_input_types: { sexual: ["image"], "sexual/minors": [] },
    })]);

    expect(await checkGenerationInput({ builtIn: true, images: [pngImage()], userId: "u1" })).toEqual({ allowed: true });
  });

  it.each([
    {},
    { sexual: ["image"], "sexual/minors": ["text"] },
    { sexual: ["text"], "sexual/minors": [] },
  ])("明确返回的覆盖范围未审核全部文本分类时拒绝：%j", async (coverage) => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult({ category_applied_input_types: coverage })]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await checkGenerationInput({ builtIn: true, prompt: "a cat", userId: "u1" })).toEqual({
      allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE,
    });
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it.each([false, true])("负面文字和图文请求也必须包含 minors 的 text 覆盖（附图=%s）", async (withImage) => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult({ category_applied_input_types: { sexual: ["text", "image"] } })]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await checkGenerationInput({
      builtIn: true, negativePrompt: "avoid blur", images: withImage ? [pngImage()] : [], userId: "u1",
    })).toEqual({ allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE });
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it("有效旧版纯文本响应不需要图片覆盖字段", async () => {
    mockResolveConfig.mockResolvedValue({ ...aiConfig(), aiModel: "text-moderation-latest" });
    mockModerationResponse([moderationResult({ category_applied_input_types: undefined })]);

    expect(await checkGenerationInput({ builtIn: true, prompt: "a cat", userId: "u1" })).toEqual({ allowed: true });
  });

  it.each(["sexual", "sexual/minors", "hate"])("分类 %s 已标记时拒绝，即使总 flagged 为 false 且分数低", async (category) => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult({
      categories: { sexual: false, "sexual/minors": false, hate: false, [category]: true },
    })]);

    expect(await checkGenerationInput({ builtIn: true, prompt: "a cat", userId: "u1" })).toEqual({
      allowed: false, message: MODERATION_BLOCK_MESSAGE,
    });
    expect(mockDb.contentReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "ai_moderation", category }),
    });
  });

  it.each([
    { builtIn: true, threshold: 0.7, score: 0.2, allowed: false },
    { builtIn: true, threshold: 0.7, score: 0.199, allowed: true },
    { builtIn: true, threshold: 0.1, score: 0.1, allowed: false },
    { builtIn: false, threshold: 0.7, score: 0.2, allowed: true },
  ])("站内 sexual 采用不高于 0.2 的站点策略，同时保留自填渠道配置：%j", async ({ builtIn, threshold, score, allowed }) => {
    mockResolveConfig.mockResolvedValue({ ...aiConfig(), aiThreshold: threshold });
    mockModerationResponse([moderationResult({ category_scores: { sexual: score, "sexual/minors": 0 } })]);

    expect((await checkGenerationInput({ builtIn, prompt: "a cat", userId: "u1" })).allowed).toBe(allowed);
    if (!allowed) {
      expect(mockDb.contentReview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ category: "sexual", aiScore: score }),
      });
    }
  });

  it("其他分类不套 sexual 的 0.2 阈值", async () => {
    mockResolveConfig.mockResolvedValue({ ...aiConfig(), aiThreshold: 0.7 });
    mockModerationResponse([moderationResult({ category_scores: { sexual: 0.01, "sexual/minors": 0, hate: 0.2 } })]);

    expect(await checkGenerationInput({ builtIn: true, prompt: "a cat", userId: "u1" })).toEqual({ allowed: true });
  });

  it("图片格式校验失败时不发审核请求，不当成内容违规", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult()]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await checkGenerationInput({
      builtIn: true, prompt: "a cat", images: [{ data: Buffer.from("not a PNG"), mimeType: "image/png" }], userId: "u1",
    })).toEqual({ allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE });
    expect(mockCheckLocalImages).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it.each([
    { messages: ["MODERATION_BLOCKED", "content_policy_violation", "safety system"], allowed: false },
    { messages: ["provider busy", "video polling failed", "bad image dimensions"], allowed: true },
  ])("冷却只统计明确内容拒绝，不把通用 PROVIDER_POLICY_REJECTED 当违规：%j", async ({ messages, allowed }) => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult()]);
    mockDb.generationJob.count.mockImplementation(({ where }: {
      where: { OR: Array<{ errorCode?: string; errorMessage?: { contains: string; mode?: string } }> };
    }) => Promise.resolve(messages.filter((message) => where.OR.some((condition) => {
      if (condition.errorCode) return condition.errorCode === "PROVIDER_POLICY_REJECTED";
      const filter = condition.errorMessage;
      return filter && (filter.mode === "insensitive"
        ? message.toLowerCase().includes(filter.contains.toLowerCase())
        : message.includes(filter.contains));
    })).length));

    expect(await checkGenerationInput({ builtIn: true, prompt: "a cat", userId: "u1" })).toEqual({
      allowed, ...(!allowed ? { message: PROVIDER_COOLDOWN_MESSAGE } : {}),
    });
  });
});
