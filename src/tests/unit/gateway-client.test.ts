import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAssertApiRateLimit,
  mockAssertModeration,
  mockFindUnique,
  mockGetEnv,
  mockGetGenerationChannelForModel,
  mockIncrementUpdate,
  mockPersistGeneratedImage,
  mockReserveOutputs,
  mockCloseReservation,
  mockUpdateMany,
} = vi.hoisted(() => ({
  mockAssertApiRateLimit: vi.fn(),
  mockAssertModeration: vi.fn(),
  mockFindUnique: vi.fn(),
  mockGetEnv: vi.fn(),
  mockGetGenerationChannelForModel: vi.fn(),
  mockIncrementUpdate: vi.fn(),
  mockPersistGeneratedImage: vi.fn(),
  mockReserveOutputs: vi.fn(),
  mockCloseReservation: vi.fn(),
  mockUpdateMany: vi.fn(),
}));

vi.mock("@/lib/api-config", () => ({
  assertApiRateLimit: mockAssertApiRateLimit,
}));

vi.mock("@/lib/moderation/check", () => ({
  assertExternalGenerationAllowed: mockAssertModeration,
}));

vi.mock("@/lib/env", () => ({
  getEnv: mockGetEnv,
}));

vi.mock("@/lib/db", () => ({
  db: {
    generationJob: { findUnique: mockFindUnique },
    user: {
      update: mockIncrementUpdate,
      updateMany: mockUpdateMany,
    },
  },
}));

vi.mock("@/lib/providers/built-in-provider", () => ({
  generationChannelModelSnapshot: (channel: { defaultModel: string; models: string[] }) =>
    [channel.defaultModel, ...channel.models],
  getGenerationChannelForModel: mockGetGenerationChannelForModel,
}));

vi.mock("@/lib/storage/persist-generated-image", () => ({
  persistGeneratedImage: mockPersistGeneratedImage,
}));
vi.mock("@/lib/storage/managed-image-storage", () => ({
  reserveManagedImageOutputs: mockReserveOutputs,
  closeManagedImageReservation: mockCloseReservation,
}));

import {
  forwardGenerationQuery,
  isGatewayEnabled,
  runExternalGenerationViaGateway,
} from "@/lib/generation/gateway-client";

const provider = {
  apiKey: "sk-test",
  baseUrl: "https://provider.test",
  creditCost: 5,
  videoCreditCost: 20,
  defaultModel: "gpt-image-2",
  id: "chn_1",
  models: ["gpt-image-2"],
  name: "Studio",
};

function setupEnv(overrides: Record<string, string> = {}) {
  const env: Record<string, unknown> = {
    AUTH_SECRET: "unit-test-secret-0123456789",
    BUILTIN_PROVIDER_MODEL: "gpt-image-2",
    GATEWAY_ENABLED: "false",
    WORKER_INTERNAL_URL: "http://127.0.0.1:8081",
  };
  for (const [key, value] of Object.entries(overrides)) {
    env[key] = value === "true" ? true : value === "false" ? false : value;
  }
  mockGetEnv.mockReturnValue(env);
}

function envelopeBodyOf(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const headers: Record<string, string> = {};
  if (init.headers) {
    for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
  }
  return { body: JSON.parse(String(init.body)), headers, init, url };
}

describe("gateway-client", () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for("narra.generation-rate-limit"));
    setupEnv();
    mockAssertApiRateLimit.mockReset().mockResolvedValue(undefined);
    mockAssertModeration.mockReset().mockResolvedValue(undefined);
    mockGetEnv.mockClear();
    mockFindUnique.mockReset().mockResolvedValue(null);
    mockIncrementUpdate.mockReset().mockResolvedValue({ id: "user_1" });
    mockUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    mockGetGenerationChannelForModel.mockReset().mockResolvedValue(provider);
    mockPersistGeneratedImage.mockReset().mockResolvedValue("https://cdn.test/source.png");
    mockReserveOutputs.mockReset().mockResolvedValue(null);
    mockCloseReservation.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ created: 123, data: [], generation_id: "job_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, Symbol.for("narra.generation-rate-limit"));
  });

  const batchInput = {
    count: 4,
    generationType: "text_to_image" as const,
    model: "gpt-image-2",
    moderation: "auto" as const,
    outputFormat: "png" as const,
    prompt: "a blue landscape",
    quality: "auto" as const,
    size: "auto" as const,
  };

  it("isGatewayEnabled 读取开关", () => {
    setupEnv({ GATEWAY_ENABLED: "true" });
    expect(isGatewayEnabled()).toBe(true);
    setupEnv({ GATEWAY_ENABLED: "false" });
    expect(isGatewayEnabled()).toBe(false);
  });

  it("内容审核不通过时不预扣积分、不转发给 Go", async () => {
    const fetchMock = vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>);
    mockAssertModeration.mockRejectedValueOnce(new Error("提交内容包含违规描述，已拒绝生成"));

    await expect(
      runExternalGenerationViaGateway({
        apiKeyId: "ck_1",
        user: { id: "usr_1", credits: 100 },
        endpoint: "responses",
        input: {
          count: 1,
          generationType: "text_to_image",
          moderation: "auto",
          outputCompression: null,
          outputFormat: "png",
          prompt: "违规描述",
          quality: "auto",
          size: "auto",
        },
      }),
    ).rejects.toThrow("提交内容包含违规描述");

    expect(mockAssertModeration).toHaveBeenCalledWith(
      "usr_1",
      expect.objectContaining({ prompt: "违规描述" }),
    );
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("四张按单价5预扣20并签名完整计费与数量，再透传Go响应", async () => {
    const fetchMock = vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>);
    const response = await runExternalGenerationViaGateway({
      apiKeyId: "ck_1",
      user: { id: "usr_1", credits: 100 },
      endpoint: "images.generations",
      responseFormat: "url",
      input: {
        count: 4,
        generationType: "text_to_image",
        model: "gpt-image-2",
        moderation: "auto",
        outputCompression: null,
        outputFormat: "png",
        prompt: "a red fox",
        quality: "auto",
        seed: 7,
        size: "1024x1024",
      },
    });
    expect(response.status).toBe(200);

    const { body, headers, init, url } = envelopeBodyOf(fetchMock);
    expect(url).toBe("http://127.0.0.1:8081/internal/gateway/v1/images/generations");
    expect(body.schemaVersion).toBe(1);
    expect(body.endpoint).toBe("images.generations");
    expect(body.auth).toEqual({ apiKeyId: "ck_1", userId: "usr_1" });
    expect(body.billing).toEqual({ creditsSpent: 20, charged: true });
    expect(body.provider).toEqual({
      channelId: "chn_1",
      channelModels: ["gpt-image-2", "gpt-image-2"],
      defaultModel: "gpt-image-2",
      providerMode: "BUILT_IN",
    });
    expect(body.payload).toMatchObject({
      count: 4,
      generationType: "TEXT_TO_IMAGE",
      model: "gpt-image-2",
      prompt: "a red fox",
      seed: 7,
      responseFormat: "url",
    });
    expect(body.jobId).toBeTruthy();
    expect(body.issuedAt).toBeTruthy();

    // 签名必须覆盖整个原始 body 且用 AUTH_SECRET
    const expected = createHmac("sha256", "unit-test-secret-0123456789")
      .update(String(init.body))
      .digest("hex");
    expect(headers["x-gateway-signature"]).toBe(expected);

    // 预扣只发生一次且金额正确
    expect(mockUpdateMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: { credits: { gte: 20 }, id: "usr_1" },
        data: { credits: { decrement: 20 } },
      }),
    );
    expect(mockReserveOutputs).toHaveBeenCalledWith(expect.objectContaining({ count: 4, ownerId: "usr_1" }));
  });

  it("余额19不能提交四张，不转发、不误退款", async () => {
    mockUpdateMany.mockImplementation(async ({ where }) => ({ count: 19 >= where.credits.gte ? 1 : 0 }));
    await expect(runExternalGenerationViaGateway({
      apiKeyId: "ck_1", user: { id: "usr_1", credits: 19 },
      endpoint: "images.generations", input: batchInput,
    })).rejects.toThrow("积分不足");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockIncrementUpdate).not.toHaveBeenCalled();
    expect(mockCloseReservation).toHaveBeenCalledOnce();
  });

  it("图生图多张参考图与count4仍只预留一张、扣5并传count1", async () => {
    const sourceImages = [
      { data: Buffer.from([1]), fileName: "a.png", mimeType: "image/png" },
      { data: Buffer.from([2]), fileName: "b.png", mimeType: "image/png" },
    ];
    await runExternalGenerationViaGateway({
      apiKeyId: "ck_1", user: { id: "usr_1", credits: 5 }, endpoint: "images.edits",
      input: { ...batchInput, generationType: "image_to_image", sourceImages },
    });
    const { body } = envelopeBodyOf(vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>));
    expect(body.payload).toMatchObject({ count: 1, generationType: "IMAGE_TO_IMAGE" });
    expect(body.billing).toEqual({ creditsSpent: 5, charged: true });
    expect(body.sourceImageUrls).toHaveLength(2);
    expect(mockReserveOutputs).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
    expect(mockUpdateMany).toHaveBeenCalledExactlyOnceWith({
      where: { credits: { gte: 5 }, id: "usr_1" }, data: { credits: { decrement: 5 } },
    });
    // 四张文生图仍能提交，说明参考图数量与伪造count没有多占图片额度。
    expect((await runExternalGenerationViaGateway({
      apiKeyId: "ck_2", user: { id: "usr_1", credits: 100 }, endpoint: "images.generations", input: batchInput,
    })).status).toBe(200);
  });

  it("预扣20后参考图上传失败仅补偿20一次", async () => {
    mockGetGenerationChannelForModel.mockResolvedValue({ ...provider, creditCost: 20 });
    mockPersistGeneratedImage.mockRejectedValue(new Error("s3 unavailable"));
    await expect(
      runExternalGenerationViaGateway({
        apiKeyId: "ck_1",
        user: { id: "usr_1", credits: 100 },
        endpoint: "images.edits",
        input: {
          count: 4,
          generationType: "image_to_image",
          model: "gpt-image-2",
          moderation: "auto",
          outputCompression: null,
          outputFormat: "png",
          prompt: "edit it",
          quality: "auto",
          size: "1024x1024",
          sourceImages: [
            { data: Buffer.from([1]), fileName: "a.png", mimeType: "image/png" },
          ],
        },
      }),
    ).rejects.toThrow("s3 unavailable");

    expect(mockIncrementUpdate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: { id: "usr_1" },
        data: { credits: { increment: 20 } },
      }),
    );
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { credits: { decrement: 20 } } }));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("Go 明确失败且 job 未创建时退款", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: "GATEWAY_ENVELOPE_INVALID", message: "bad", type: "invalid_request_error" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const response = await runExternalGenerationViaGateway({
      apiKeyId: "ck_1",
      user: { id: "usr_1", credits: 100 },
      endpoint: "chat.completions",
      input: {
        count: 4,
        generationType: "text_to_image",
        model: "gpt-image-2",
        moderation: "auto",
        outputCompression: null,
        outputFormat: "png",
        prompt: "hi",
        quality: "auto",
        size: "auto",
      },
    });
    expect(response.status).toBe(400);
    expect(mockIncrementUpdate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ data: { credits: { increment: 20 } } }),
    );
  });

  it("Go 超时且 job 已创建时不退款", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: "GENERATION_WAIT_TIMEOUT", message: "timeout", type: "server_error" },
            generation_id: "job_1",
          }),
          { status: 504, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    mockFindUnique.mockResolvedValue({ apiKeyId: "ck_1" });

    const response = await runExternalGenerationViaGateway({
      apiKeyId: "ck_1",
      user: { id: "usr_1", credits: 100 },
      endpoint: "responses",
      input: {
        count: 4,
        generationType: "text_to_image",
        model: "gpt-image-2",
        moderation: "auto",
        outputCompression: null,
        outputFormat: "png",
        prompt: "hi",
        quality: "auto",
        size: "auto",
      },
    });
    expect(response.status).toBe(504);
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { credits: { decrement: 20 } } }));
    expect(mockIncrementUpdate).not.toHaveBeenCalled();
  });

  it("转发失败且任务状态查询也失败时不擅自退回20", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("upstream connection lost"));
    mockFindUnique.mockRejectedValue(new Error("database unavailable"));
    await expect(runExternalGenerationViaGateway({
      apiKeyId: "ck_1", user: { id: "usr_1", credits: 100 },
      endpoint: "images.generations", input: batchInput,
    })).rejects.toThrow("database unavailable");
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { credits: { decrement: 20 } } }));
    expect(mockIncrementUpdate).not.toHaveBeenCalled();
  });

  it("连接失败且 job 未创建时退款并返回 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const response = await runExternalGenerationViaGateway({
      apiKeyId: "ck_1",
      user: { id: "usr_1", credits: 100 },
      endpoint: "images.generations",
      input: {
        count: 1,
        generationType: "text_to_image",
        model: "gpt-image-2",
        moderation: "auto",
        outputCompression: null,
        outputFormat: "png",
        prompt: "hi",
        quality: "auto",
        size: "auto",
      },
    });
    expect(response.status).toBe(502);
    expect(mockIncrementUpdate).toHaveBeenCalled();
  });

  it("abort 且 job 已存在时不退款并返回查询语义", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("Aborted", "AbortError");
      }),
    );
    // 最常见的断连时机：Go 已创建 job，客户端在长等待中断开。
    mockFindUnique.mockResolvedValue({ apiKeyId: "ck_1" });

    const response = await runExternalGenerationViaGateway({
      apiKeyId: "ck_1",
      user: { id: "usr_1", credits: 100 },
      endpoint: "images.generations",
      signal: controller.signal,
      input: {
        count: 1,
        generationType: "text_to_image",
        model: "gpt-image-2",
        moderation: "auto",
        outputCompression: null,
        outputFormat: "png",
        prompt: "hi",
        quality: "auto",
        size: "auto",
      },
    });
    expect(response.status).toBe(504);
    expect(mockIncrementUpdate).not.toHaveBeenCalled();
  });

  it("abort 且 job 未创建时退款并返回 502", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("Aborted", "AbortError");
      }),
    );
    mockFindUnique.mockResolvedValue(null);

    const response = await runExternalGenerationViaGateway({
      apiKeyId: "ck_1",
      user: { id: "usr_1", credits: 100 },
      endpoint: "images.generations",
      signal: controller.signal,
      input: {
        count: 1,
        generationType: "text_to_image",
        model: "gpt-image-2",
        moderation: "auto",
        outputCompression: null,
        outputFormat: "png",
        prompt: "hi",
        quality: "auto",
        size: "auto",
      },
    });
    expect(response.status).toBe(502);
    expect(mockIncrementUpdate).toHaveBeenCalled();
  });

  it("forwardGenerationQuery 携带签名与 api key 并透传", async () => {
    const fetchMock = vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>);
    const response = await forwardGenerationQuery({ apiKeyId: "ck_1", jobId: "job_1" });
    expect(response.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/internal/gateway/v1/generations/job_1");
    const rawHeaders = init.headers as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      headers[key.toLowerCase()] = value;
    }
    const expected = createHmac("sha256", "unit-test-secret-0123456789")
      .update("job_1")
      .digest("hex");
    expect(headers["x-gateway-signature"]).toBe(expected);
    expect(headers["x-gateway-api-key"]).toBe("ck_1");
  });
});
