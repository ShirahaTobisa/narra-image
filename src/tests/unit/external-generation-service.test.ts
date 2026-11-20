import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasPng } from "./helpers/canvas-api-fixtures";

const {
  mockAssertApiRateLimit,
  mockAssertModeration,
  mockCheckLocalImages,
  mockCreateReview,
  mockCreateGenerationJob,
  mockFailGenerationJobAndRefund,
  mockFindGenerationJob,
  mockGetActiveChannels,
  mockPersistGeneratedImage,
  mockResolveModerationConfig,
  mockTopLevelGenerationJobUpdate,
  mockTransaction,
  mockUserUpdateMany,
} = vi.hoisted(() => ({
  mockAssertApiRateLimit: vi.fn(),
  mockAssertModeration: vi.fn(),
  mockCheckLocalImages: vi.fn(),
  mockCreateReview: vi.fn(),
  mockCreateGenerationJob: vi.fn(),
  mockFailGenerationJobAndRefund: vi.fn(),
  mockFindGenerationJob: vi.fn(),
  mockGetActiveChannels: vi.fn(),
  mockPersistGeneratedImage: vi.fn(),
  mockResolveModerationConfig: vi.fn(),
  mockTopLevelGenerationJobUpdate: vi.fn(),
  mockTransaction: vi.fn(),
  mockUserUpdateMany: vi.fn(),
}));

vi.mock("@/lib/api-config", () => ({
  assertApiRateLimit: mockAssertApiRateLimit,
}));

vi.mock("@/lib/moderation/check", () => ({
  assertExternalGenerationAllowed: mockAssertModeration,
}));
vi.mock("@/lib/moderation/config", () => ({ resolveModerationConfig: mockResolveModerationConfig }));
vi.mock("@/lib/moderation/local-images", () => ({ checkLocalImages: mockCheckLocalImages }));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mockTransaction,
    contentReview: { create: mockCreateReview },
    generationJob: {
      count: vi.fn(async () => 0),
      findFirst: mockFindGenerationJob,
      update: mockTopLevelGenerationJobUpdate,
    },
  },
}));

vi.mock("@/lib/generation/job-refund", () => ({
  failGenerationJobAndRefund: mockFailGenerationJobAndRefund,
}));

vi.mock("@/lib/providers/built-in-provider", () => ({
  generationChannelModelSnapshot: (channel: {
    defaultModel: string;
    models: string[];
  }) => [channel.defaultModel, ...channel.models],
  getGenerationChannelForModel: async (model: string) => {
    const channels = await mockGetActiveChannels();
    const matched = channels.find((channel: {
      defaultModel: string;
      models: string[];
    }) => channel.defaultModel === model || channel.models.includes(model));
    if (!matched) throw new Error("模型不可用");
    return matched;
  },
}));

vi.mock("@/lib/storage/persist-generated-image", () => ({
  persistGeneratedImage: mockPersistGeneratedImage,
}));

import { runExternalGeneration } from "@/lib/generation/external-api";

const tx = {
  $executeRaw: vi.fn().mockResolvedValue(1),
  generationJob: {
    create: mockCreateGenerationJob,
  },
  user: {
    updateMany: mockUserUpdateMany,
  },
};

describe("外部 API 生成服务", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    process.env.AUTH_SECRET = "unit-test-secret";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/test";
    process.env.EXTERNAL_GENERATION_POLL_INTERVAL_MS = "1";
    process.env.EXTERNAL_GENERATION_WAIT_TIMEOUT_SECONDS = "1";

    mockAssertApiRateLimit.mockReset();
    mockAssertModeration.mockReset().mockResolvedValue(undefined);
    mockCheckLocalImages.mockReset().mockResolvedValue({ blocked: false });
    mockCreateReview.mockReset();
    mockResolveModerationConfig.mockReset().mockResolvedValue({
      aiApiKey: "moderation-test-key", aiBaseUrl: "https://moderation.invalid/v1", aiEnabled: true,
      aiModel: "omni-moderation-latest", aiThreshold: 0.5, isEnabled: true, sensitiveWordsEnabled: true,
    });
    mockCreateGenerationJob.mockReset();
    mockFailGenerationJobAndRefund.mockReset();
    mockFindGenerationJob.mockReset();
    mockGetActiveChannels.mockReset();
    mockPersistGeneratedImage.mockReset();
    mockTopLevelGenerationJobUpdate.mockReset();
    mockTransaction.mockReset();
    mockUserUpdateMany.mockReset();

    mockTransaction.mockImplementation((callback) => callback(tx));
    mockCreateGenerationJob.mockResolvedValue({
      id: "job_1",
      images: [],
    });
    mockTopLevelGenerationJobUpdate.mockResolvedValue({ id: "job_1" });
    mockUserUpdateMany.mockResolvedValue({ count: 1 });
    mockPersistGeneratedImage.mockResolvedValue("https://cdn.example/source.png");
    mockFindGenerationJob.mockResolvedValue({
      createdAt: new Date("2026-05-05T12:00:00.000Z"),
      errorMessage: null,
      id: "job_1",
      images: [{ height: 1024, url: "https://example.com/out.png", width: 1024 }],
      model: "gpt-image-2",
      status: "SUCCEEDED",
    });
    mockGetActiveChannels.mockResolvedValue([
      {
        apiKey: "first-key",
        baseUrl: "https://first.example/v1",
        creditCost: 5,
        defaultModel: "gpt-image-2",
        id: "channel_1",
        models: [],
        name: "默认渠道",
      },
      {
        apiKey: "second-key",
        baseUrl: "https://second.example/v1",
        creditCost: 7,
        defaultModel: "seedream",
        id: "channel_2",
        models: ["seedream-pro"],
        name: "备用渠道",
      },
    ]);
  });

  it.each(["blocked", "unavailable"])("真实共享本机图片检查 %s 时不远程请求、不扣费、不上传或建任务", async (outcome) => {
    const { assertExternalGenerationAllowed } = await vi.importActual<typeof import("@/lib/moderation/check")>("@/lib/moderation/check");
    mockAssertModeration.mockImplementation(assertExternalGenerationAllowed);
    if (outcome === "blocked") {
      mockCheckLocalImages.mockResolvedValue({ blocked: true, category: "sexual", score: 0.8, model: "nsfwjs/MobileNetV2Mid@4.4.0" });
    } else {
      mockCheckLocalImages.mockRejectedValue(new Error("本机检查超时"));
      vi.spyOn(console, "error").mockImplementation(() => {});
    }
    const remoteFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected remote request"));
    const sourceImages = [{ data: canvasPng(), mimeType: "image/png", fileName: "reference.png" }];

    await expect(runExternalGeneration({
      apiKeyId: "key_1", user: { credits: 500, id: "user_1" },
      input: {
        count: 1, generationType: "image_to_image", model: "gpt-image-2", moderation: "auto",
        outputFormat: "png", prompt: "a blue landscape", quality: "auto", size: "auto", sourceImages,
      },
    })).rejects.toMatchObject({ code: "content_policy_violation", status: 400 });
    expect(mockCheckLocalImages).toHaveBeenCalledWith(sourceImages);
    expect(remoteFetch).not.toHaveBeenCalled();
    expect(mockPersistGeneratedImage).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockCreateGenerationJob).not.toHaveBeenCalled();
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });

  it("按请求模型匹配渠道并交给 Worker", async () => {
    await runExternalGeneration({
      apiKeyId: "key_1",
      input: {
        count: 1,
        generationType: "text_to_image",
        model: "seedream-pro",
        moderation: "auto",
        outputFormat: "png",
        prompt: "测试提示词",
        quality: "auto",
        seed: 12345,
        size: "auto",
      },
      user: { credits: 500, id: "user_1" },
    });

    expect(mockCreateGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          creditsSpent: 7,
          model: "seedream-pro",
          providerChannelId: "channel_2",
          seed: 12345,
          status: "PENDING",
          workerManaged: false,
        }),
      }),
    );
    expect(mockTopLevelGenerationJobUpdate).toHaveBeenCalledWith({
      where: { id: "job_1" },
      data: { workerManaged: true },
    });
    expect(mockFindGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          apiKeyId: "key_1",
          clientSource: "API",
          id: "job_1",
        }),
      }),
    );
  });

  it("图生图先保存参考图，再开放 Worker", async () => {
    await runExternalGeneration({
      apiKeyId: "key_1",
      input: {
        count: 4,
        generationType: "image_to_image",
        moderation: "auto",
        outputFormat: "png",
        prompt: "测试提示词",
        quality: "auto",
        size: "auto",
        sourceImages: [
          {
            data: Buffer.from([1, 2, 3]),
            fileName: "source.png",
            mimeType: "image/png",
          },
        ],
      },
      user: { credits: 500, id: "user_1" },
    });

    expect(mockCreateGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          count: 1,
          generationType: "IMAGE_TO_IMAGE",
          sourceImageUrls: [],
          workerManaged: false,
        }),
      }),
    );
    expect(mockPersistGeneratedImage).toHaveBeenCalledWith({
      buffer: Buffer.from([1, 2, 3]),
      fileExtension: "png",
      mimeType: "image/png",
      userId: "user_1",
    });
    expect(mockTopLevelGenerationJobUpdate).toHaveBeenCalledWith({
      where: { id: "job_1" },
      data: {
        sourceImageUrls: ["https://cdn.example/source.png"],
        workerManaged: true,
      },
    });
  });

  it("内容审核（含参考图）不通过时不扣积分、不建任务", async () => {
    mockAssertModeration.mockRejectedValueOnce(new Error("提交内容包含违规描述，已拒绝生成"));
    const sourceImages = [
      { data: Buffer.from([1, 2, 3]), fileName: "source.png", mimeType: "image/png" },
    ];

    await expect(
      runExternalGeneration({
        apiKeyId: "key_1",
        input: {
          count: 1,
          generationType: "image_to_image",
          moderation: "auto",
          outputFormat: "png",
          prompt: "违规描述",
          quality: "auto",
          size: "auto",
          sourceImages,
        },
        user: { credits: 500, id: "user_1" },
      }),
    ).rejects.toThrow("提交内容包含违规描述");

    expect(mockAssertModeration).toHaveBeenCalledWith(
      "user_1",
      expect.objectContaining({ prompt: "违规描述", sourceImages }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockCreateGenerationJob).not.toHaveBeenCalled();
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
    expect(mockPersistGeneratedImage).not.toHaveBeenCalled();
  });

  it("积分不足时不保存参考图，也不开放 Worker", async () => {
    mockUserUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      runExternalGeneration({
        apiKeyId: "key_1",
        input: {
          count: 1,
          generationType: "image_to_image",
          moderation: "auto",
          outputFormat: "png",
          prompt: "测试提示词",
          quality: "auto",
          size: "auto",
          sourceImages: [
            {
              data: Buffer.from([1, 2, 3]),
              fileName: "source.png",
              mimeType: "image/png",
            },
          ],
        },
        user: { credits: 0, id: "user_1" },
      }),
    ).rejects.toThrow("积分不足");

    expect(mockPersistGeneratedImage).not.toHaveBeenCalled();
    expect(mockTopLevelGenerationJobUpdate).not.toHaveBeenCalled();
    expect(mockFailGenerationJobAndRefund).not.toHaveBeenCalled();
  });

  it("开放 Worker 前失败会退款", async () => {
    mockPersistGeneratedImage.mockRejectedValue(new Error("上传失败"));

    await expect(
      runExternalGeneration({
        apiKeyId: "key_1",
        input: {
          count: 1,
          generationType: "image_to_image",
          moderation: "auto",
          outputFormat: "png",
          prompt: "测试提示词",
          quality: "auto",
          size: "auto",
          sourceImages: [
            {
              data: Buffer.from([1, 2, 3]),
              fileName: "source.png",
              mimeType: "image/png",
            },
          ],
        },
        user: { credits: 500, id: "user_1" },
      }),
    ).rejects.toThrow("上传失败");

    expect(mockFailGenerationJobAndRefund).toHaveBeenCalledWith({
      errorMessage: "上传失败",
      jobId: "job_1",
    });
  });

  it("Worker 返回失败时不重复退款", async () => {
    mockFindGenerationJob.mockResolvedValue({
      errorMessage: "渠道请求失败",
      id: "job_1",
      images: [],
      status: "FAILED",
    });

    await expect(
      runExternalGeneration({
        apiKeyId: "key_1",
        input: {
          count: 1,
          generationType: "text_to_image",
          moderation: "auto",
          outputFormat: "png",
          prompt: "测试提示词",
          quality: "auto",
          size: "auto",
        },
        user: { credits: 500, id: "user_1" },
      }),
    ).rejects.toThrow("渠道请求失败");

    expect(mockFailGenerationJobAndRefund).not.toHaveBeenCalled();
  });
});
