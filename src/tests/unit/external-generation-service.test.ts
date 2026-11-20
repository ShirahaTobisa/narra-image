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
  mockReserveOutputs,
  mockCloseReservation,
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
  mockReserveOutputs: vi.fn(),
  mockCloseReservation: vi.fn(),
  mockTopLevelGenerationJobUpdate: vi.fn(),
  mockTransaction: vi.fn(),
  mockUserUpdateMany: vi.fn(),
}));

vi.mock("@/lib/api-config", () => ({
  assertApiRateLimit: mockAssertApiRateLimit,
}));
vi.mock("@/lib/server/api-auth", () => ({
  requireApiUser: vi.fn(async () => ({
    apiKey: { id: "http_key" }, user: { credits: 500, id: "user_1" },
  })),
}));

vi.mock("@/lib/moderation/check", () => ({
  assertExternalGenerationAllowed: mockAssertModeration,
}));
vi.mock("@/lib/moderation/config", () => ({ resolveModerationConfig: mockResolveModerationConfig }));
vi.mock("@/lib/moderation/local-images", () => ({ checkLocalImages: mockCheckLocalImages }));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mockTransaction,
    contentReview: { count: vi.fn(async () => 0), create: mockCreateReview },
    generationJob: {
      count: vi.fn(async () => 0),
      findFirst: mockFindGenerationJob,
      findUnique: vi.fn(async () => null),
      update: mockTopLevelGenerationJobUpdate,
    },
    user: { updateMany: mockUserUpdateMany, update: vi.fn() },
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
vi.mock("@/lib/storage/managed-image-storage", () => ({
  reserveManagedImageOutputs: mockReserveOutputs,
  bindManagedImageOutputs: vi.fn(),
  closeManagedImageReservation: mockCloseReservation,
}));

import { runExternalGeneration } from "@/lib/generation/external-api";
import { runExternalGenerationViaGateway } from "@/lib/generation/gateway-client";
import { POST as imagePost } from "@/app/v1/images/generations/route";
import { POST as imageEditPost } from "@/app/v1/images/edits/route";
import { POST as responsesPost } from "@/app/v1/responses/route";

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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    Reflect.deleteProperty(globalThis, Symbol.for("narra.generation-rate-limit"));
  });
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for("narra.generation-rate-limit"));
    vi.stubEnv("AUTH_SECRET", "unit-test-secret");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@127.0.0.1:1/test");
    vi.stubEnv("EXTERNAL_GENERATION_POLL_INTERVAL_MS", "1");
    vi.stubEnv("EXTERNAL_GENERATION_WAIT_TIMEOUT_SECONDS", "1");
    vi.stubEnv("GATEWAY_ENABLED", "false");

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
    mockReserveOutputs.mockReset().mockResolvedValue(null);
    mockCloseReservation.mockReset().mockResolvedValue(undefined);

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

  const textInput = {
    count: 4,
    generationType: "text_to_image" as const,
    moderation: "auto" as const,
    outputFormat: "png" as const,
    prompt: "a blue landscape",
    quality: "auto" as const,
    size: "auto" as const,
  };

  it("文生图四张按单价5扣20，预留与任务张数一致", async () => {
    await runExternalGeneration({
      apiKeyId: "key_1", user: { credits: 20, id: "user_1" }, input: textInput,
    });
    expect(mockCreateGenerationJob).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ count: 4, creditsSpent: 20 }),
    }));
    expect(mockReserveOutputs).toHaveBeenCalledWith(expect.objectContaining({ count: 4, ownerId: "user_1" }));
    expect(mockUserUpdateMany).toHaveBeenCalledExactlyOnceWith({
      where: { credits: { gte: 20 }, id: "user_1" },
      data: { credits: { decrement: 20 } },
    });
  });

  it("余额19时四张请求在同一事务回滚，不扣费或交给Worker", async () => {
    let balance = 19;
    const committedJobs: unknown[] = [];
    mockUserUpdateMany.mockImplementation(async ({ where, data }) => {
      if (balance < where.credits.gte) return { count: 0 };
      balance -= data.credits.decrement;
      return { count: 1 };
    });
    mockTransaction.mockImplementation(async (callback) => {
      const previousBalance = balance;
      try {
        const job = await callback(tx);
        committedJobs.push(job);
        return job;
      } catch (error) {
        balance = previousBalance;
        throw error;
      }
    });

    await expect(runExternalGeneration({
      apiKeyId: "key_1", user: { credits: 19, id: "user_1" }, input: textInput,
    })).rejects.toThrow("积分不足");
    expect(balance).toBe(19);
    expect(committedJobs).toEqual([]);
    expect(mockTopLevelGenerationJobUpdate).not.toHaveBeenCalled();
    expect(mockFailGenerationJobAndRefund).not.toHaveBeenCalled();
    expect(mockCloseReservation).toHaveBeenCalledOnce();
  });

  it("同用户的legacy与网关及不同API Key共用五张额度，拒绝的2张不占剩余1张", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
    const user = { credits: 100, id: "shared_user" };
    await runExternalGeneration({ apiKeyId: "legacy_key", user, input: textInput });

    const gateway = (count: number, apiKeyId: string, id = user.id) => runExternalGenerationViaGateway({
      apiKeyId, user: { ...user, id }, endpoint: "images.generations", input: { ...textInput, count },
    });
    await expect(gateway(2, "gateway_key")).rejects.toMatchObject({ status: 429 });
    expect(mockAssertModeration).toHaveBeenCalledOnce();
    expect(mockUserUpdateMany).toHaveBeenCalledOnce();
    expect(mockReserveOutputs).toHaveBeenCalledOnce();
    expect(upstream).not.toHaveBeenCalled();

    expect((await gateway(1, "another_key")).status).toBe(200);
    await expect(runExternalGeneration({
      apiKeyId: "fourth_key", user, input: { ...textInput, count: 1 },
    })).rejects.toMatchObject({ status: 429 });
    expect(mockUserUpdateMany).toHaveBeenCalledTimes(2);
    expect(mockCreateGenerationJob).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledOnce();
    expect((await gateway(4, "other_user_key", "other_user")).status).toBe(200);
    expect(mockAssertApiRateLimit.mock.calls.map(([key]) => key)).toEqual([
      "legacy_key", "gateway_key", "another_key", "fourth_key", "other_user_key",
    ]);
  });

  it("原API Key请求限流拒绝后不消耗图片额度", async () => {
    mockAssertApiRateLimit.mockRejectedValueOnce(new Error("API Key请求过多"));
    await expect(runExternalGeneration({
      apiKeyId: "key_1", user: { credits: 100, id: "user_1" }, input: textInput,
    })).rejects.toThrow("API Key请求过多");
    expect(mockAssertModeration).not.toHaveBeenCalled();
    await runExternalGeneration({ apiKeyId: "key_2", user: { credits: 100, id: "user_1" }, input: textInput });
    expect(mockCreateGenerationJob).toHaveBeenCalledOnce();
  });

  it.each(["generations", "edits", "responses"] as const)("真实 %s 路由在Kelivo保活/SSE前返回图片额度HTTP429", async (endpoint) => {
    for (const count of [4, 1]) {
      await runExternalGeneration({
        apiKeyId: `key_${count}`, user: { credits: 100, id: "user_1" }, input: { ...textInput, count },
      });
    }
    mockAssertModeration.mockClear();
    mockTransaction.mockClear();
    mockUserUpdateMany.mockClear();
    mockReserveOutputs.mockClear();
    mockPersistGeneratedImage.mockClear();
    const upstream = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected upstream request"));

    let response: Response;
    if (endpoint === "edits") {
      const form = new FormData();
      form.set("prompt", "a blue landscape");
      form.set("image", new File([new Uint8Array(canvasPng())], "reference.png", { type: "image/png" }));
      const request = new Request("https://app.invalid/v1/images/edits", {
        method: "POST", headers: { "User-Agent": "Kelivo" }, body: form,
      });
      request.formData = async () => form;
      response = await imageEditPost(request);
    } else {
      const body = endpoint === "responses"
        ? { input: "a blue landscape", tools: [{ type: "image_generation" }], stream: true }
        : { prompt: "a blue landscape" };
      const request = new Request(`https://app.invalid/v1/${endpoint === "responses" ? endpoint : "images/generations"}`, {
        method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Kelivo" }, body: JSON.stringify(body),
      });
      response = await (endpoint === "responses" ? responsesPost : imagePost)(request);
    }
    const body = await response.text();
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(body)).toMatchObject({ error: { code: "rate_limit_exceeded", type: "rate_limit_error" } });
    expect(mockAssertModeration).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
    expect(mockReserveOutputs).not.toHaveBeenCalled();
    expect(mockPersistGeneratedImage).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("真实Kelivo四张请求仍完成保活响应且只占四张额度", async () => {
    const response = await imagePost(new Request("https://app.invalid/v1/images/generations", {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Kelivo" },
      body: JSON.stringify({ prompt: "a blue landscape", n: 4 }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ generation_id: "job_1" });
    expect(mockCreateGenerationJob).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ count: 4, creditsSpent: 20 }) }));
    await runExternalGeneration({
      apiKeyId: "other_key", user: { credits: 100, id: "user_1" }, input: { ...textInput, count: 1 },
    });
    expect(mockUserUpdateMany).toHaveBeenCalledTimes(2);
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

  it("图生图多张参考图与count4仍按一张扣5，再开放 Worker", async () => {
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
          {
            data: Buffer.from([4, 5, 6]),
            fileName: "second.png",
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
          creditsSpent: 5,
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
        sourceImageUrls: ["https://cdn.example/source.png", "https://cdn.example/source.png"],
        workerManaged: true,
      },
    });
    expect(mockReserveOutputs).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
    expect(mockUserUpdateMany).toHaveBeenCalledWith({
      where: { credits: { gte: 5 }, id: "user_1" },
      data: { credits: { decrement: 5 } },
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

  it("四张任务交给Worker前失败只调用一次现有退款流程，任务保留实际20积分", async () => {
    mockTopLevelGenerationJobUpdate.mockRejectedValue(new Error("交接失败"));
    await expect(runExternalGeneration({
      apiKeyId: "key_1", user: { credits: 20, id: "user_1" }, input: textInput,
    })).rejects.toThrow("交接失败");
    expect(mockCreateGenerationJob).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ count: 4, creditsSpent: 20 }),
    }));
    expect(mockFailGenerationJobAndRefund).toHaveBeenCalledExactlyOnceWith({ errorMessage: "交接失败", jobId: "job_1" });
  });

  it("四张任务Worker返回失败时不重复退款", async () => {
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
          count: 4,
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
