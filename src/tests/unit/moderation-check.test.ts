import { beforeEach, describe, expect, it, vi } from "vitest";
import { canvasPng } from "./helpers/canvas-api-fixtures";

const { mockDb, mockResolveConfig, mockMatchWords, mockCheckLocalImages, mockPrecheck } = vi.hoisted(() => {
  const contentReview = { count: vi.fn(), create: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() };
  const generationJob = { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() };
  const user = { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() };
  const resolveConfig = vi.fn();
  const matchWords = vi.fn();
  return {
    mockDb: { contentReview, generationJob, user },
    mockCheckLocalImages: vi.fn(),
    mockMatchWords: matchWords,
    mockPrecheck: vi.fn(),
    mockResolveConfig: resolveConfig,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/moderation/precheck", () => ({ precheckGeneration: mockPrecheck }));
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
  CONSECUTIVE_REFUSAL_BAN_LIMIT,
  listModerationOffenders,
  PRECHECK_BLOCK_MESSAGE,
  REFUSAL_BAN_MESSAGE,
  MANUAL_PAUSE_MESSAGE,
  AI_BLOCK_MESSAGE,
  MODERATION_UNAVAILABLE_MESSAGE,
  PROVIDER_COOLDOWN_MESSAGE,
  SENSITIVE_WORD_BLOCK_MESSAGE,
} from "@/lib/moderation/check";
import { LOCAL_IMAGE_MODEL } from "@/lib/moderation/local-images";
import { ModerationFailure } from "@/lib/moderation/failure";

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

function sentModerationBody(call = 0) {
  const [, init] = vi.mocked(global.fetch).mock.calls[call] as [string, RequestInit];
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
    mockDb.contentReview.count.mockReset().mockResolvedValue(0);
    mockDb.contentReview.create.mockReset().mockResolvedValue({});
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
    expect(JSON.parse(errorSpy.mock.calls[0][1])).toMatchObject({
      event: "moderation_failure", stage: "remote_text", errorClass: "Error", code: "Error",
      imageCount: 0, imageIndex: null, images: [], httpStatus: null,
    });
  });

  it("图片格式失败记录对应序号与有限元数据，不记录原图或用户输入", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const images = Array.from({ length: 20 }, () => pngImage());
    images[1].mimeType = "image/png;private-filename.png;https://private-host";

    expect(await checkGenerationInput({
      builtIn: true, images, prompt: "private-prompt", negativePrompt: "private-negative", userId: "private-account",
    })).toEqual({ allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE });
    const diagnostic = JSON.parse(errorSpy.mock.calls[0][1]);
    expect(diagnostic).toMatchObject({
      stage: "image_validation", code: "image_mime_mismatch", actualFormat: "png", imageCount: 20, imageIndex: 1,
      durationMs: expect.any(Number), errorClass: "ModerationFailure", httpStatus: null,
    });
    expect(diagnostic.durationMs).toBeGreaterThanOrEqual(0);
    expect(diagnostic.images).toHaveLength(16);
    expect(diagnostic.images[1]).toEqual({ mimeType: "other", byteLength: images[1].data.byteLength });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(/private-|base64|iVBOR|Bearer/);
    expect(mockCheckLocalImages).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it("本机失败保留固定原因与当前图片序号", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockCheckLocalImages.mockRejectedValue(new ModerationFailure("local_decode_failed", {
      imageIndex: 1, message: "private-runtime", actualFormat: "private-format",
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkGenerationInput({ builtIn: true, images: [pngImage(), pngImage()], userId: "private-account" }))
      .toEqual({ allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE });
    expect(JSON.parse(errorSpy.mock.calls[0][1])).toMatchObject({
      stage: "local_image", code: "local_decode_failed", actualFormat: "other", imageIndex: 1, imageCount: 2,
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("private-");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it("远程图片失败记录HTTP状态与序号，不读取上游错误正文", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    const json = vi.fn().mockResolvedValue({ secret: "private-response" });
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ results: [moderationResult()] }) })
      .mockResolvedValueOnce({ ok: false, status: 429, json });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await checkGenerationInput({ builtIn: true, images: [pngImage(), pngImage()], userId: "private-account" }))
      .toEqual({ allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE });
    expect(JSON.parse(errorSpy.mock.calls[0][1])).toMatchObject({
      stage: "remote_image", code: "remote_http_status", httpStatus: 429, imageIndex: 1, imageCount: 2,
    });
    expect(json).not.toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(/private-|base64|iVBOR|Bearer/);
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it.each([
    { response: { results: [{ categories: { "private-field": "private-payload" } }] }, code: "remote_response_invalid" },
    { response: { results: [moderationResult({ category_applied_input_types: { sexual: ["image"], "sexual/minors": ["image"] } })] }, code: "remote_input_coverage" },
  ])("远程响应异常记录固定原因 $code", async ({ response, code }) => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await checkGenerationInput({ prompt: "private-prompt", userId: "private-account" }))
      .toEqual({ allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE });
    expect(JSON.parse(errorSpy.mock.calls[0][1])).toMatchObject({ stage: "remote_text", code, httpStatus: 200 });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("private-");
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it.each(["TimeoutError", "AbortError", "private-error-name"])("异常名称只记录固定值：%s", async (name) => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    global.fetch = vi.fn().mockRejectedValue(Object.assign(new Error("private-message"), { name, code: "private-code" }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await checkGenerationInput({ prompt: "private-prompt", userId: "private-account" });
    expect(JSON.parse(errorSpy.mock.calls[0][1])).toMatchObject({
      stage: "remote_text", errorClass: name.startsWith("private-") ? "UnknownError" : name,
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("private-");
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

  it("带参考图时提示词先单独送审，再和图一起送审", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult()]);

    const result = await checkGenerationInput({
      builtIn: true,
      images: [pngImage()],
      prompt: "make it blue",
      userId: "u1",
    });

    expect(result.allowed).toBe(true);
    expect(sentModerationBody()).toEqual({ input: "make it blue", model: "omni-moderation-latest" });
    expect(sentModerationBody(1)).toEqual({
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
    })).toEqual({ allowed: false, message: AI_BLOCK_MESSAGE });
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
    // 文字单独一次，然后每张图各一次（审核接口一次只收一张图），顺序和原图一致。
    expect(global.fetch).toHaveBeenCalledTimes(17);
    originalBytes.forEach((bytes, index) => {
      expect(sentModerationBody(index + 1).input).toEqual([
        { type: "text", text: "a blue landscape" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` } },
      ]);
    });
  });

  it("本机通过后仍执行远程审核，远程拒绝记录远程模型", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult({ category_scores: { sexual: 0.9, "sexual/minors": 0 }, flagged: true })]);

    expect(await checkGenerationInput({ builtIn: true, prompt: "a blue landscape", images: [pngImage()], userId: "u1" })).toEqual({
      allowed: false, message: AI_BLOCK_MESSAGE,
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

  it("审核模型判定涉及未成年人色情就拒，即使分数低于通用阈值", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult({
      categories: { sexual: false, "sexual/minors": true, hate: false },
      category_scores: { sexual: 0.3, "sexual/minors": 0.2 },
    })]);

    const result = await checkGenerationInput({ prompt: "borderline", userId: "u1" });

    expect(result.allowed).toBe(false);
    expect(mockDb.contentReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ aiScore: 0.2, category: "sexual/minors" }),
    });
  });

  it("带了参考图，文字单独审该拒的照样拒（带图一起审分数会变低）", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult({
      categories: { sexual: false, "sexual/minors": true, hate: false },
      category_scores: { sexual: 0.3, "sexual/minors": 0.2 },
    })]);

    expect(await checkGenerationInput({ builtIn: true, prompt: "text", images: [pngImage()], userId: "u1" })).toEqual({
      allowed: false, message: AI_BLOCK_MESSAGE,
    });
    expect(sentModerationBody().input).toBe("text");
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it("未成年人分类只是有点分数、模型没判定时放行", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult({ category_scores: { sexual: 0.3, "sexual/minors": 0.1 } })]);

    expect(await checkGenerationInput({ builtIn: true, prompt: "adult character", userId: "u1" })).toEqual({ allowed: true });
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it("多张参考图逐张送审（接口一次只收一张图），任何一张该拒就拒", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    const answer = (result: unknown) => ({ json: async () => ({ results: [result] }), ok: true });
    const refused = moderationResult({ category_scores: { sexual: 0.9, "sexual/minors": 0, hate: 0 } });
    // 依次是：文字单独、第一张图、第二张图。
    global.fetch = vi.fn()
      .mockResolvedValueOnce(answer(moderationResult()))
      .mockResolvedValueOnce(answer(moderationResult()))
      .mockResolvedValueOnce(answer(refused));

    expect(await checkGenerationInput({ builtIn: true, prompt: "two references", images: [pngImage(), pngImage()], userId: "u1" }))
      .toEqual({ allowed: false, message: AI_BLOCK_MESSAGE });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(sentModerationBody(0).input).toBe("two references");
    for (const call of [1, 2]) {
      const parts = sentModerationBody(call).input as Array<{ type: string }>;
      expect(parts.map((part) => part.type)).toEqual(["text", "image_url"]);
    }
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
    // 站内渠道查两遍：连续被拒（封号）和 24 小时内被拒（暂停）。
    expect(mockDb.generationJob.count).toHaveBeenCalledTimes(2);

    await expect(
      checkGenerationInput({ builtIn: false, prompt: "a cat", userId: "u1" }),
    ).resolves.toEqual({ allowed: true });
    expect(mockDb.generationJob.count).toHaveBeenCalledTimes(2);
    expect(mockDb.contentReview.count).toHaveBeenCalledTimes(2);
  });

  it("后台违规榜把本站拒绝和上游拒绝按人合计，暂停中的排最前", async () => {
    const day = (date: number) => new Date(Date.UTC(2026, 10, date));
    const group = (userId: string, count: number, last: Date) => ({ _count: { _all: count }, _max: { createdAt: last }, userId });
    const block = (userId: string, date: number) => ({ createdAt: day(date), userId });
    mockDb.contentReview.groupBy.mockResolvedValue([group("earlier", 9, day(10)), group("mixed", 1, day(20)), group("forgiven", 3, day(20))]);
    mockDb.generationJob.groupBy.mockResolvedValue([group("mixed", 2, day(21)), group("upstream-only", 3, day(21))]);
    // 最近 24 小时的记录逐条取，才能按每个人的解除时间取舍。
    mockDb.contentReview.findMany.mockResolvedValue([block("mixed", 20), block("forgiven", 20), block("forgiven", 20), block("forgiven", 20)]);
    mockDb.generationJob.findMany.mockResolvedValue([
      block("mixed", 21), block("mixed", 21), block("upstream-only", 21), block("upstream-only", 21), block("upstream-only", 21),
    ]);
    // forgiven：三次被拒之后管理员解除了暂停；hand-paused：一条记录都没有，被管理员手动暂停。
    mockDb.user.findMany.mockResolvedValue([
      { generationPausedAt: null, id: "forgiven", moderationClearedAt: day(21) },
      { generationPausedAt: day(21), id: "hand-paused", moderationClearedAt: null },
    ]);

    expect(await listModerationOffenders(10)).toEqual([
      { count: 3, lastAt: day(21), manual: false, paused: true, recentCount: 3, userId: "mixed" },
      { count: 3, lastAt: day(21), manual: false, paused: true, recentCount: 3, userId: "upstream-only" },
      { count: 0, lastAt: null, manual: true, paused: true, recentCount: 0, userId: "hand-paused" },
      { count: 9, lastAt: day(10), manual: false, paused: false, recentCount: 0, userId: "earlier" },
      { count: 3, lastAt: day(20), manual: false, paused: false, recentCount: 0, userId: "forgiven" },
    ]);
    expect(mockDb.generationJob.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ createdAt: { gte: expect.any(Date) }, providerMode: "BUILT_IN", status: "FAILED" }),
    }));
  });

  it("预审判定会被上游拒时拦下并单独记一类，不送预审的请求不问", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult()]);
    mockPrecheck.mockResolvedValue({ model: "deepseek-flash", reason: "年龄不明角色擦边", refuse: true });

    expect(await checkGenerationInput({ builtIn: true, precheck: true, prompt: "a school girl", userId: "u1" }))
      .toEqual({ allowed: false, message: PRECHECK_BLOCK_MESSAGE });
    expect(mockPrecheck).toHaveBeenCalledWith("a school girl", []);
    expect(mockDb.contentReview.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      aiModel: "deepseek-flash", category: "年龄不明角色擦边", kind: "precheck", prompt: "a school girl", userId: "u1",
    }) });
    // 预审会误拦，不拿它算封号。
    expect(mockDb.generationJob.findFirst).toHaveBeenCalledTimes(1);

    mockPrecheck.mockClear();
    await expect(checkGenerationInput({ builtIn: true, prompt: "a gallery title", userId: "u1" })).resolves.toEqual({ allowed: true });
    expect(mockPrecheck).not.toHaveBeenCalled();
  });

  it("管理员出图不过站内审核，也不查暂停和封号", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({ role: "ADMIN" });
    mockMatchWords.mockReturnValue([{ category: "fixture", word: "fixture" }]);

    expect(await checkGenerationInput({ builtIn: true, precheck: true, prompt: "fixture", userId: "admin" })).toEqual({ allowed: true });
    expect(mockResolveConfig).not.toHaveBeenCalled();
    expect(mockPrecheck).not.toHaveBeenCalled();
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it(`从最近一次成功出图之后连续被拒满 ${CONSECUTIVE_REFUSAL_BAN_LIMIT} 次就封号`, async () => {
    const lastSuccess = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    mockDb.generationJob.findFirst.mockResolvedValue({ createdAt: lastSuccess });
    mockDb.contentReview.count.mockResolvedValue(2);
    mockDb.generationJob.count.mockResolvedValue(3);

    expect(await checkGenerationInput({ builtIn: true, prompt: "a cat", userId: "u1" }))
      .toEqual({ allowed: false, message: REFUSAL_BAN_MESSAGE });
    expect(mockDb.contentReview.count).toHaveBeenCalledWith({ where: expect.objectContaining({ createdAt: { gte: lastSuccess }, userId: "u1" }) });
    expect(mockDb.user.update).toHaveBeenCalledWith({ data: { bannedAt: expect.any(Date) }, where: { id: "u1" } });
    expect(mockResolveConfig).not.toHaveBeenCalled();
  });

  it("差一次就不封；第五次正好是本站拒的，当场封号", async () => {
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockMatchWords.mockReturnValue([{ category: "fixture", word: "fixture" }]);
    mockDb.generationJob.count.mockResolvedValue(0);
    mockDb.contentReview.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValue(5);

    expect(await checkGenerationInput({ builtIn: true, prompt: "fixture", userId: "u1" }))
      .toEqual({ allowed: false, message: REFUSAL_BAN_MESSAGE });
    expect(mockDb.contentReview.create).toHaveBeenCalledOnce();
    expect(mockDb.user.update).toHaveBeenCalledOnce();
  });

  it("管理员手动暂停的账号直接拦，不查次数也不送审", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({ generationPausedAt: new Date(), moderationClearedAt: null });

    expect(await checkGenerationInput({ builtIn: true, prompt: "a cat", userId: "u1" }))
      .toEqual({ allowed: false, message: MANUAL_PAUSE_MESSAGE });
    expect(mockDb.generationJob.count).not.toHaveBeenCalled();
    expect(mockResolveConfig).not.toHaveBeenCalled();
  });

  it("管理员解除暂停后，之前被拒的不再计数", async () => {
    const cleared = new Date(Date.now() - 60_000);
    mockDb.user.findUnique.mockResolvedValueOnce({ generationPausedAt: null, moderationClearedAt: cleared });
    mockResolveConfig.mockResolvedValue(aiConfig());
    mockModerationResponse([moderationResult()]);

    await expect(checkGenerationInput({ builtIn: true, prompt: "a cat", userId: "u1" })).resolves.toEqual({ allowed: true });
    expect(mockDb.generationJob.count).toHaveBeenCalledWith({ where: expect.objectContaining({ createdAt: { gte: cleared }, userId: "u1" }) });
    expect(mockDb.contentReview.count).toHaveBeenCalledWith({ where: expect.objectContaining({ createdAt: { gte: cleared } }) });
  });

  describe("站内与上游共用用户违规计数", () => {
    type Review = { userId: string; createdAt: Date; kind: string };
    type Job = { userId: string; createdAt: Date; status: string; providerMode: string; errorMessage: string };
    const at = Date.parse("2026-11-21T00:00:00Z");
    const review = (overrides: Partial<Review> = {}): Review => ({ userId: "u1", createdAt: new Date(at), kind: "ai_moderation", ...overrides });
    const job = (overrides: Partial<Job> = {}): Job => ({ userId: "u1", createdAt: new Date(at), status: "FAILED", providerMode: "BUILT_IN", errorMessage: "moderation_blocked", ...overrides });

    function history(reviews: Review[] = [], jobs: Job[] = []) {
      vi.spyOn(Date, "now").mockReturnValue(at);
      mockResolveConfig.mockResolvedValue(aiConfig());
      mockModerationResponse([moderationResult()]);
      mockDb.contentReview.count.mockImplementation(async ({ where }: {
        where: { userId: string; createdAt: { gte: Date }; kind: { in: string[] } };
      }) => reviews.filter((item) => item.userId === where.userId && item.createdAt >= where.createdAt.gte && where.kind.in.includes(item.kind)).length);
      mockDb.contentReview.create.mockImplementation(async ({ data }: { data: { userId: string; kind: string } }) => {
        reviews.push(review(data));
        return reviews.at(-1);
      });
      mockDb.generationJob.count.mockImplementation(async ({ where }: {
        where: { userId: string; createdAt: { gte: Date }; providerMode: string; status: string; OR: Array<{ errorMessage: { contains: string; mode: string } }> };
      }) => jobs.filter((item) => item.userId === where.userId && item.createdAt >= where.createdAt.gte
        && item.status === where.status && item.providerMode === where.providerMode
        && where.OR.some(({ errorMessage }) => errorMessage.mode === "insensitive"
          ? item.errorMessage.toLowerCase().includes(errorMessage.contains.toLowerCase())
          : item.errorMessage.includes(errorMessage.contains))).length);
      return { reviews, jobs };
    }

    it.each([
      { label: "提示词", input: { prompt: "a blue landscape" } },
      { label: "公开署名文字", input: { prompt: "Fixture Author" } },
      { label: "头像等纯图片", input: { images: [pngImage()] } },
    ])("两次站内明确拒绝加一次上游拒绝，下一次$label提交直接暂停", async ({ input }) => {
      history([review({ kind: "sensitive_word" }), review()], [job()]);
      expect(await checkGenerationInput({ builtIn: true, ...input, userId: "u1" }))
        .toEqual({ allowed: false, message: PROVIDER_COOLDOWN_MESSAGE });
      expect(mockResolveConfig).not.toHaveBeenCalled();
      expect(mockCheckLocalImages).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockDb.contentReview.create).not.toHaveBeenCalled();
    });

    it("每次只记一条：词库、本机图片、远端预审分别拒绝后，第4次暂停", async () => {
      const state = history();
      const input = { builtIn: true, prompt: "fixture prompt", userId: "u1" };
      mockMatchWords.mockReturnValue([{ category: "fixture", word: "fixture" }]);
      expect(await checkGenerationInput(input)).toEqual({ allowed: false, message: SENSITIVE_WORD_BLOCK_MESSAGE });
      expect(state.reviews).toHaveLength(1);
      expect(mockCheckLocalImages).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();

      mockMatchWords.mockReturnValue([]);
      mockCheckLocalImages.mockResolvedValue({ blocked: true, category: "sexual", score: 0.8, model: LOCAL_IMAGE_MODEL });
      expect(await checkGenerationInput({ ...input, images: [pngImage()] })).toEqual({ allowed: false, message: AI_BLOCK_MESSAGE });
      expect(state.reviews).toHaveLength(2);
      expect(global.fetch).not.toHaveBeenCalled();

      mockCheckLocalImages.mockResolvedValue({ blocked: false });
      const overThreshold = moderationResult({ category_scores: { sexual: 0.9, "sexual/minors": 0, hate: 0 } });
      mockModerationResponse([overThreshold, overThreshold]);
      expect(await checkGenerationInput({ ...input, images: [pngImage()] })).toEqual({ allowed: false, message: AI_BLOCK_MESSAGE });
      expect(state.reviews).toHaveLength(3);
      expect(state.jobs).toHaveLength(0);
      expect(global.fetch).toHaveBeenCalledOnce();

      expect(await checkGenerationInput(input)).toEqual({ allowed: false, message: PROVIDER_COOLDOWN_MESSAGE });
      expect(state.reviews).toHaveLength(3);
      expect(global.fetch).toHaveBeenCalledOnce();
    });

    it("查询只计同一用户24小时内的明确拒绝，单条上游记录匹配多个标记仍只计一次", async () => {
      const old = new Date(at - 25 * 60 * 60 * 1000);
      const state = history([
        review(), review({ kind: "sensitive_word" }), review({ userId: "other" }), review({ createdAt: old }),
        review({ kind: "unavailable" }), review({ kind: "timeout" }),
      ], [
        job({ userId: "other" }), job({ createdAt: old }), job({ status: "SUCCEEDED" }), job({ providerMode: "CUSTOM" }),
        job({ errorMessage: "upstream timeout" }), job({ errorMessage: "provider unavailable" }),
      ]);
      const input = { builtIn: true, prompt: "a blue landscape", userId: "u1" };
      expect(await checkGenerationInput(input)).toEqual({ allowed: true });
      state.jobs.push(job({ errorMessage: "MODERATION_BLOCKED content_policy_violation safety system" }));
      expect(await checkGenerationInput(input)).toEqual({ allowed: false, message: PROVIDER_COOLDOWN_MESSAGE });
      expect(mockDb.contentReview.count).toHaveBeenCalledWith({ where: {
        createdAt: { gte: new Date(at - 24 * 60 * 60 * 1000) }, kind: { in: ["sensitive_word", "ai_moderation"] }, userId: "u1",
      } });
    });

    it.each(["local", "timeout", "service", "config"])("已有两次违规时%s故障不凑成第三次，恢复后可继续审核", async (failure) => {
      const state = history([review(), review({ kind: "sensitive_word" })]);
      vi.spyOn(console, "error").mockImplementation(() => {});
      if (failure === "local") mockCheckLocalImages.mockRejectedValue(new Error("fixture model unavailable"));
      if (failure === "timeout") global.fetch = vi.fn().mockRejectedValue(new DOMException("fixture timeout", "TimeoutError"));
      if (failure === "service") global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      if (failure === "config") mockResolveConfig.mockRejectedValue(new Error("fixture config unavailable"));
      const input = { builtIn: true, prompt: "a blue landscape", userId: "u1", images: [pngImage()] };
      expect(await checkGenerationInput(input)).toEqual({ allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE });
      expect(state.reviews).toHaveLength(2);
      expect(mockDb.contentReview.create).not.toHaveBeenCalled();
      mockCheckLocalImages.mockResolvedValue({ blocked: false });
      mockResolveConfig.mockResolvedValue(aiConfig());
      mockModerationResponse([moderationResult()]);
      expect(await checkGenerationInput(input)).toEqual({ allowed: true });
    });

    it.each(["contentReview", "generationJob"] as const)("%s计数失败时停止审核，不泄漏详情或新增违规", async (table) => {
      const state = history([review(), review({ kind: "sensitive_word" })]);
      mockDb[table].count.mockRejectedValueOnce(new Error("fixture secret-key private-db-url"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await checkGenerationInput({ builtIn: true, prompt: "a blue landscape", userId: "u1" }))
        .toEqual({ allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE });
      expect(state.reviews).toHaveLength(2);
      expect(mockDb.contentReview.create).not.toHaveBeenCalled();
      expect(mockResolveConfig).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(/secret-key|private-db-url/);
    });
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

  it.each(["sexual", "hate"])("审核模型自己标记了 %s、但分数没到后台阈值时放行", async (category) => {
    mockResolveConfig.mockResolvedValue({ ...aiConfig(), aiThreshold: 0.7 });
    mockModerationResponse([moderationResult({
      categories: { sexual: false, "sexual/minors": false, hate: false, [category]: true },
      category_scores: { sexual: 0.01, "sexual/minors": 0, hate: 0, [category]: 0.699 },
      flagged: true,
    })]);

    expect(await checkGenerationInput({ builtIn: true, prompt: "a cat", userId: "u1" })).toEqual({ allowed: true });
    expect(mockDb.contentReview.create).not.toHaveBeenCalled();
  });

  it.each([
    { threshold: 0.7, score: 0.7, allowed: false },
    { threshold: 0.7, score: 0.699, allowed: true },
    { threshold: 0.1, score: 0.1, allowed: false },
  ])("站内色情和其他分类一样按后台阈值判定：%j", async ({ threshold, score, allowed }) => {
    mockResolveConfig.mockResolvedValue({ ...aiConfig(), aiThreshold: threshold });
    mockModerationResponse([moderationResult({ category_scores: { sexual: score, "sexual/minors": 0 } })]);

    expect((await checkGenerationInput({ builtIn: true, prompt: "a cat", userId: "u1" })).allowed).toBe(allowed);
    if (!allowed) {
      expect(mockDb.contentReview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ category: "sexual", aiScore: score }),
      });
    }
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
