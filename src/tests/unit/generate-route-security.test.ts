import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const {
  mockCheckGenerationInput,
  mockConversationFindFirst,
  mockImageFindFirst,
  mockJobFindFirst,
  mockDbTransaction,
  mockRawQuery,
  mockDecryptProviderSecret,
  mockEncryptProviderSecret,
  mockFailGenerationJobAndRefund,
  mockGetGenerationChannelById,
  mockGetGenerationChannelForModel,
  mockParseGenerateRequest,
  mockPersistGeneratedImage,
  mockRequireCurrentUserRecord,
  mockRequireTurnstile,
  mockSavedProviderFindUnique,
} = vi.hoisted(() => ({
  mockCheckGenerationInput: vi.fn(),
  mockConversationFindFirst: vi.fn(),
  mockImageFindFirst: vi.fn(),
  mockJobFindFirst: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockRawQuery: vi.fn(),
  mockDecryptProviderSecret: vi.fn(),
  mockEncryptProviderSecret: vi.fn(),
  mockFailGenerationJobAndRefund: vi.fn(),
  mockGetGenerationChannelById: vi.fn(),
  mockGetGenerationChannelForModel: vi.fn(),
  mockParseGenerateRequest: vi.fn(),
  mockPersistGeneratedImage: vi.fn(),
  mockRequireCurrentUserRecord: vi.fn(),
  mockRequireTurnstile: vi.fn(),
  mockSavedProviderFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mockDbTransaction,
    $queryRaw: mockRawQuery,
    conversation: { findFirst: mockConversationFindFirst },
    generationImage: { findFirst: mockImageFindFirst },
    generationJob: { findFirst: mockJobFindFirst },
    savedProviderConfig: { findUnique: mockSavedProviderFindUnique },
  },
}));

// 站内渠道会把引用的本站图读出来送审；这里只关心绑定流程，读图直接给假数据
vi.mock("@/lib/storage/managed-image-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage/managed-image-storage")>();
  return {
    ...actual,
    readManagedImage: vi.fn(async () => Buffer.from("reference-image")),
    reserveManagedImageOutputs: vi.fn(actual.reserveManagedImageOutputs),
  };
});

vi.mock("@/lib/moderation/check", () => ({
  checkGenerationInput: mockCheckGenerationInput,
}));

const rateLimit = vi.hoisted(() => ({ limited: false }));

vi.mock("@/lib/server/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/rate-limit")>();
  return {
    ...actual,
    createRateLimiter: (options: Parameters<typeof actual.createRateLimiter>[0]) => ({
      ...actual.createRateLimiter(options),
      isLimited: () => rateLimit.limited,
      record: () => undefined,
    }),
  };
});

const env = vi.hoisted(() => ({ VIDEO_ENABLED: true }));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    AUTH_SECRET: "unit-test-secret",
    APP_URL: "https://app.unit.invalid",
    IMAGE_STORAGE_MANAGED_ENABLED: false,
    BUILTIN_PROVIDER_CREDIT_COST: 5,
    BUILTIN_PROVIDER_VIDEO_CREDIT_COST: 20,
    CUSTOM_PROVIDER_ENABLED: true,
    VIDEO_ENABLED: env.VIDEO_ENABLED,
    WORKER_CONTRACTS_V1_ENABLED: false,
  }),
}));

vi.mock("@/lib/generation/parse-generate-request", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/generation/parse-generate-request")>();
  return {
    ...original,
    parseGenerateRequest: mockParseGenerateRequest,
  };
});

vi.mock("@/lib/prisma-mappers", () => ({
  serializeGeneration: vi.fn((job) => job),
  toPrismaGenerationType: vi.fn((value) => value),
  toPrismaProviderMode: vi.fn((value) => value),
}));

vi.mock("@/lib/providers/built-in-provider", () => ({
  generationChannelModelSnapshot: (channel: { defaultModel: string; models: string[] }) => [
    channel.defaultModel,
    ...channel.models,
  ],
  getGenerationChannelById: mockGetGenerationChannelById,
  getGenerationChannelForModel: mockGetGenerationChannelForModel,
}));

vi.mock("@/lib/providers/provider-secret", () => ({
  decryptProviderSecret: mockDecryptProviderSecret,
  encryptProviderSecret: mockEncryptProviderSecret,
}));

vi.mock("@/lib/auth/turnstile", () => ({
  requireTurnstile: mockRequireTurnstile,
}));

vi.mock("@/lib/server/current-user", () => ({
  requireCurrentUserRecord: mockRequireCurrentUserRecord,
}));

vi.mock("@/lib/storage/persist-generated-image", () => ({
  persistGeneratedImage: mockPersistGeneratedImage,
}));

vi.mock("@/lib/generation/job-refund", () => ({
  failGenerationJobAndRefund: mockFailGenerationJobAndRefund,
}));

import { POST } from "@/app/api/generate/route";
import { imageLocalLocation, type ManagedImage } from "@/lib/storage/image-contract";
import { ImageRepository } from "@/lib/storage/image-repository";
import { reserveManagedImageOutputs } from "@/lib/storage/managed-image-storage";

function readyManagedInput(): ManagedImage {
  const id = "11111111-1111-4111-8111-111111111111";
  const objectId = "22222222-2222-4222-8222-222222222222";
  const stamp = "2026-11-15T00:00:00.000Z";
  const location = imageLocalLocation("33333333-3333-4333-8333-333333333333");
  return {
    asset: { id, ownerId: "original-image-owner", purpose: "REFERENCE", originId: null, publicToken: "a".repeat(64),
      byteLength: "10", mimeType: "image/png", sha256: "b".repeat(64), state: "AVAILABLE", activeObjectId: objectId,
      detachedAt: stamp, expiresAt: null, deletedAt: null, deleteReason: null, createdAt: stamp, updatedAt: stamp },
    object: { id: objectId, assetId: id, provenance: "OBSERVED", sourceObservationId: "44444444-4444-4444-8444-444444444444", reconciliationObservationId: null,
      reservationId: null, slot: null, writeToken: null, writeExpiresAt: null, putOutcome: "NOT_APPLICABLE",
      locationId: location.id, physicalNamespace: location.id, key: "images/original.png", byteLength: "10", mimeType: "image/png", sha256: "b".repeat(64),
      state: "READY", versionId: null, accounted: true, needsReconciliation: false, deleteToken: null, deleteExpiresAt: null,
      deleteOutcome: "NOT_STARTED", deleteAttempts: 0, nextDeleteAt: null, deletedAt: null, lastErrorCode: null, createdAt: stamp, updatedAt: stamp },
    location: { ...location, physicalNamespace: location.id, createdAt: stamp },
  };
}

function buildRequestBody(overrides: Record<string, unknown> = {}) {
  const image = new File(["image"], "reference.png", { type: "image/png" });
  return {
    aspectRatio: null,
    channelId: undefined,
    conversationId: undefined,
    count: 1,
    customProvider: null,
    durationSeconds: null,
    generationType: "image_to_image",
    image,
    imageUrls: ["https://8.8.8.8/reference.png"],
    images: [image],
    model: "gpt-image-1",
    moderation: "auto",
    negativePrompt: null,
    outputCompression: null,
    outputFormat: "png",
    prompt: "测试生成请求",
    providerMode: "built_in",
    quality: "auto",
    replaceGenerationId: undefined,
    seed: null,
    size: "auto",
    turnstileToken: undefined,
    ...overrides,
  };
}

function submissionTransaction() {
  let job: Record<string, unknown>;
  const create = vi.fn(async ({ data }) => (job = { ...data, id: "new-job", images: [], videos: [] }));
  const charge = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0), $queryRaw: mockRawQuery,
    generationJob: {
      count: vi.fn().mockResolvedValue(0), create,
      updateMany: vi.fn(async ({ data }) => { Object.assign(job, data); return { count: 1 }; }),
      findUniqueOrThrow: vi.fn(async () => job),
    },
    user: { updateMany: charge, findUnique: mockRequireCurrentUserRecord }, imageUrlAlias: { findMany: vi.fn().mockResolvedValue([]) },
  };
  mockDbTransaction.mockImplementation(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
  mockPersistGeneratedImage.mockResolvedValue("https://app.unit.invalid/upload.png");
  return { create, charge };
}

describe("生成接口安全校验顺序", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for("narra.generation-rate-limit"));
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    Reflect.deleteProperty(globalThis, Symbol.for("narra.generation-rate-limit"));
    mockRawQuery.mockImplementation(async (query: Prisma.Sql) => {
      if (query.text !== "SELECT image_resolve_url($1::text,$2::text) AS result" || query.values[1] !== null) {
        throw new Error("Unexpected generation-security fixture query");
      }
      return [{ result: null }];
    });
    mockRequireCurrentUserRecord.mockResolvedValue({ credits: 100, id: "user_1" });
    mockGetGenerationChannelForModel.mockResolvedValue({
      apiKey: "builtin-key",
      baseUrl: "https://provider.example.com/v1",
      creditCost: 5,
      defaultModel: "gpt-image-1",
      id: "channel_1",
      models: ["gpt-image-1"],
      name: "内置渠道",
      videoCreditCost: 20,
    });
    mockRequireTurnstile.mockResolvedValue(undefined);
    mockFailGenerationJobAndRefund.mockResolvedValue({ updated: true, refundedCredits: 5 });
    mockCheckGenerationInput.mockResolvedValue({ allowed: true });
    mockImageFindFirst.mockResolvedValue(null);
    mockJobFindFirst.mockResolvedValue(null);
    env.VIDEO_ENABLED = true;
    rateLimit.limited = false;
  });

  it("站内渠道只接受本站图片作参考图，外部链接在上传前拒绝", async () => {
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({
      imageUrls: ["https://8.8.8.8/reference.png"],
    }));

    const response = await POST(new Request("https://example.com/api/generate", { method: "POST" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "使用站内渠道时参考图请直接上传，不支持外部图片链接",
    });
    expect(mockPersistGeneratedImage).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it("自填渠道的参考图 URL 指向内网时在上传前拒绝", async () => {
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({
      customProvider: {
        apiKey: "custom-key",
        baseUrl: "https://8.8.4.4/v1",
        label: "自填渠道",
        model: "custom-model",
        models: ["custom-model"],
        remember: false,
      },
      imageUrls: ["http://127.0.0.1/private.png"],
      model: "custom-model",
      providerMode: "custom",
    }));

    const response = await POST(new Request("https://example.com/api/generate", { method: "POST" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "参考图 URL仅支持公网 HTTP(S) 地址",
    });
    expect(mockPersistGeneratedImage).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it("自填渠道指向内网时在加密和上传前拒绝", async () => {
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({
      customProvider: {
        apiKey: "custom-key",
        baseUrl: "http://[::1]/v1",
        label: "自填渠道",
        model: "custom-model",
        models: ["custom-model"],
        remember: false,
      },
      model: "custom-model",
      providerMode: "custom",
    }));

    const response = await POST(new Request("https://example.com/api/generate", { method: "POST" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "自填渠道 Base URL仅支持公网 HTTP(S) 地址",
    });
    expect(mockEncryptProviderSecret).not.toHaveBeenCalled();
    expect(mockPersistGeneratedImage).not.toHaveBeenCalled();
  });

  it("已保存的自填渠道指向内网时同样拒绝", async () => {
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({
      customProvider: null,
      model: "custom-model",
      providerMode: "custom",
    }));
    mockSavedProviderFindUnique.mockResolvedValue({
      apiKeyEncrypted: "encrypted-key",
      baseUrl: "http://10.0.0.8/v1",
      label: "已保存渠道",
      model: "custom-model",
      models: ["custom-model"],
    });
    mockDecryptProviderSecret.mockResolvedValue("custom-key");

    const response = await POST(new Request("https://example.com/api/generate", { method: "POST" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "自填渠道 Base URL仅支持公网 HTTP(S) 地址",
    });
    expect(mockDecryptProviderSecret).toHaveBeenCalledWith(
      "encrypted-key",
      "unit-test-secret",
    );
    expect(mockEncryptProviderSecret).not.toHaveBeenCalled();
    expect(mockPersistGeneratedImage).not.toHaveBeenCalled();
  });

  it("无权访问的会话在上传参考图前拒绝", async () => {
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({
      conversationId: "conversation_other",
      imageUrls: [],
    }));
    mockConversationFindFirst.mockResolvedValue(null);

    const response = await POST(new Request("https://example.com/api/generate", { method: "POST" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "会话不存在或不属于当前用户",
    });
    expect(mockConversationFindFirst).toHaveBeenCalled();
    expect(mockPersistGeneratedImage).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it("每分钟请求超过上限时直接拒绝，不解析、不送审", async () => {
    rateLimit.limited = true;

    const response = await POST(new Request("https://example.com/api/generate", { method: "POST" }));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("请求太频繁") });
    expect(mockParseGenerateRequest).not.toHaveBeenCalled();
    expect(mockCheckGenerationInput).not.toHaveBeenCalled();
  });

  it("视频功能关闭时拒绝视频请求，不送审、不建 job", async () => {
    env.VIDEO_ENABLED = false;
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({ generationType: "text_to_video" }));

    const response = await POST(new Request("https://example.com/api/generate", { method: "POST" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "本站暂不支持视频生成" });
    expect(mockCheckGenerationInput).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it("内容审核命中时拒绝生成且不建 job/不扣积分", async () => {
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({ imageUrls: [] }));
    mockCheckGenerationInput.mockResolvedValueOnce({
      allowed: false,
      message: "提交内容包含违规描述，已拒绝生成",
    });

    const response = await POST(
      new Request("https://example.com/api/generate", { method: "POST" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "提交内容包含违规描述，已拒绝生成",
    });
    // 站内渠道：上传的参考图要和提示词一起送审，并标记为站内渠道（用于上游拦截计数）
    expect(mockCheckGenerationInput).toHaveBeenCalledWith(
      expect.objectContaining({
        builtIn: true,
        images: [expect.objectContaining({ data: Buffer.from("image"), mimeType: "image/png" })],
        prompt: "测试生成请求",
        userId: "user_1",
      }),
    );
    expect(mockPersistGeneratedImage).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it.each([false, true])("规范 token 输入在提交事务内绑定，清理竞态=%s", async (cleanedBeforeCommit) => {
    const image = readyManagedInput();
    const rawUrl = `https://APP.unit.invalid:443/media/images/${image.asset.publicToken}`;
    const canonicalUrl = `https://app.unit.invalid/media/images/${image.asset.publicToken}`;
    const sourceUrls = Object.freeze([rawUrl]);
    const aliases = new Map<string, string>();
    const persistedInputs: string[][] = [];
    let inTransaction = false;
    vi.spyOn(ImageRepository.prototype, "getByToken").mockImplementation(async () => cleanedBeforeCommit && inTransaction
      ? { asset: { ...image.asset, state: "DELETED", activeObjectId: null }, object: null, location: null } : image);
    vi.spyOn(ImageRepository.prototype, "registerAlias").mockImplementation(async ({ assetId, url }) => {
      expect(inTransaction).toBe(true);
      aliases.set(url, assetId);
    });
    let stored: Record<string, unknown>;
    const create = vi.fn(async ({ data }: { data: { sourceImageUrls: string[] } }) => {
      expect(aliases.get(rawUrl)).toBe(image.asset.id);
      persistedInputs.push([...data.sourceImageUrls]);
      return stored = { ...data, id: "new-reference-job", images: [], videos: [] };
    });
    const charge = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0), $queryRaw: mockRawQuery,
      generationJob: {
        count: vi.fn().mockResolvedValue(0), create,
        updateMany: vi.fn(async ({ data }) => { Object.assign(stored, data); return { count: 1 }; }),
        findUniqueOrThrow: vi.fn(async () => stored),
      }, user: { updateMany: charge, findUnique: mockRequireCurrentUserRecord },
      imageUrlAlias: { findMany: vi.fn(async () => [...aliases].map(([url]) => ({ url, asset: image.asset }))) },
    };
    mockDbTransaction.mockImplementation(async (operation: (client: typeof tx) => Promise<unknown>) => {
      inTransaction = true;
      try { return await operation(tx); }
      finally { inTransaction = false; }
    });
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({ imageUrls: sourceUrls, images: [], image: null }));
    const response = await POST(new Request("https://app.unit.invalid/api/generate", { method: "POST" }));
    if (cleanedBeforeCommit) {
      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({ code: "IMAGE_UNAVAILABLE" });
      expect(create).not.toHaveBeenCalled();
      expect(charge).not.toHaveBeenCalled();
      expect(aliases.size).toBe(0);
    } else {
      expect({ status: response.status, body: await response.clone().json() }).toMatchObject({ status: 200 });
      await expect(response.json()).resolves.toMatchObject({ data: { generation: { sourceImageUrls: [canonicalUrl] } } });
      expect(persistedInputs).toEqual([[rawUrl]]);
      expect(charge).toHaveBeenCalledOnce();
      // 引用的本站图也要读出来和提示词一起送审
      expect(mockCheckGenerationInput).toHaveBeenCalledWith(expect.objectContaining({
        builtIn: true,
        images: [expect.objectContaining({ data: Buffer.from("reference-image") })],
      }));
    }
    expect(sourceUrls).toEqual([rawUrl]);
    expect(mockPersistGeneratedImage).not.toHaveBeenCalled();
    expect(mockFailGenerationJobAndRefund).toHaveBeenCalledTimes(cleanedBeforeCommit ? 1 : 0);
  });

  it("数据库旧图可继续生成，混合上传和旧图保持原顺序且都经过审核", async () => {
    const first = "data:image/png;base64,aW1hZ2UtMQ==";
    const second = "data:image/png;base64,aW1hZ2UtMg==";
    mockImageFindFirst.mockResolvedValue({ id: "own-image" });
    submissionTransaction();
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({ imageUrls: [first, second], imageInputOrder: ["url", "file", "url"] }));
    const response = await POST(new Request("https://app.unit.invalid/api/generate", { method: "POST" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { generation: { sourceImageUrls: [first, "https://app.unit.invalid/upload.png", second] } } });
    expect(mockCheckGenerationInput).toHaveBeenCalledWith(expect.objectContaining({ images: [
      expect.objectContaining({ data: Buffer.from("image") }),
      expect.objectContaining({ data: Buffer.from("image-1") }),
      expect.objectContaining({ data: Buffer.from("image-2") }),
    ] }));
  });

  it.each([
    ["普通用户指定渠道也不认，按模型自动选", "USER", false],
    ["管理员可以指定渠道", "ADMIN", true],
  ])("%s", async (_label, role, honored) => {
    mockRequireCurrentUserRecord.mockResolvedValue({ credits: 100, id: "user_1", role });
    mockGetGenerationChannelById.mockResolvedValue(await mockGetGenerationChannelForModel());
    mockGetGenerationChannelForModel.mockClear();
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({ channelId: "ch_backup", image: null, imageUrls: [], images: [] }));
    mockDbTransaction.mockRejectedValueOnce(new Error("stop after channel selection"));

    await POST(new Request("https://app.unit.invalid/api/generate", { method: "POST" }));

    expect(mockGetGenerationChannelById).toHaveBeenCalledTimes(honored ? 1 : 0);
    expect(mockGetGenerationChannelForModel).toHaveBeenCalledTimes(honored ? 0 : 1);
  });

  it("每人同时最多 2 个任务在生成，再交就拒绝，不建任务也不扣分", async () => {
    const create = vi.fn();
    const charge = vi.fn();
    const executeRaw = vi.fn().mockResolvedValue(1);
    const tx = { $executeRaw: executeRaw, generationJob: { count: vi.fn().mockResolvedValue(2), create }, user: { updateMany: charge, findUnique: mockRequireCurrentUserRecord } };
    mockDbTransaction.mockImplementation(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({ generationType: "text_to_image", image: null, imageUrls: [], images: [] }));

    const response = await POST(new Request("https://app.unit.invalid/api/generate", { method: "POST" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("同时最多 2 个任务") });
    expect(String(executeRaw.mock.calls[0][0].join("?"))).toContain("image_lock_reference_epoch");
    expect(String(executeRaw.mock.calls[1][0].join("?"))).toContain("FOR UPDATE");
    expect(create).not.toHaveBeenCalled();
    expect(charge).not.toHaveBeenCalled();
  });

  it.each([19, 20])("文生图4张单价5，余额%s时按20积分校验与扣费", async (credits) => {
    const { create, charge } = submissionTransaction();
    mockRequireCurrentUserRecord.mockResolvedValue({ credits, id: "user_1" });
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({ generationType: "text_to_image", count: 4, images: [], imageUrls: [] }));
    const response = await POST(new Request("https://app.unit.invalid/api/generate", { method: "POST" }));
    expect(response.status).toBe(credits === 19 ? 402 : 200);
    if (credits === 19) {
      expect(create).not.toHaveBeenCalled();
      expect(charge).not.toHaveBeenCalled();
      expect(reserveManagedImageOutputs).not.toHaveBeenCalled();
      return;
    }
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ count: 4, creditsSpent: 20 }) }));
    expect(charge).toHaveBeenCalledWith({ where: { id: "user_1", credits: { gte: 20 } }, data: { credits: { decrement: 20 } } });
    expect(reserveManagedImageOutputs).toHaveBeenCalledWith(expect.objectContaining({ count: 4 }));
  });

  it("图生图多张参考图且篡改count=4仍只预留、扣费和保存1张输出", async () => {
    const { create, charge } = submissionTransaction();
    const reference = new File(["image"], "source.png", { type: "image/png" });
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({ count: 4, images: [reference, reference], imageUrls: [] }));
    const response = await POST(new Request("https://app.unit.invalid/api/generate", { method: "POST" }));
    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ count: 1, creditsSpent: 5 }) }));
    expect(charge).toHaveBeenCalledWith({ where: { id: "user_1", credits: { gte: 5 } }, data: { credits: { decrement: 5 } } });
    expect(reserveManagedImageOutputs).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
  });

  it("先提交4张后拒绝2张，剩余1张仍可用且超额不验证码、送审或扣费", async () => {
    const { create, charge } = submissionTransaction();
    const submit = async (count: number) => {
      mockParseGenerateRequest.mockResolvedValue(buildRequestBody({ generationType: "text_to_image", count, images: [], imageUrls: [] }));
      return POST(new Request("https://app.unit.invalid/api/generate", { method: "POST" }));
    };
    expect((await submit(4)).status).toBe(200);
    const denied = await submit(2);
    expect(denied.status).toBe(429);
    expect(await denied.json()).toMatchObject({ error: expect.stringContaining("5 张") });
    expect(mockRequireTurnstile).toHaveBeenCalledTimes(1);
    expect(mockCheckGenerationInput).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledTimes(1);
    expect((await submit(1)).status).toBe(200);
    expect(create).toHaveBeenCalledTimes(2);
    expect(charge.mock.calls.map(([input]) => input.data.credits.decrement)).toEqual([20, 5]);
  });

  it("不同用户的图片额度互不占用", async () => {
    const { create } = submissionTransaction();
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({ generationType: "text_to_image", count: 4, images: [], imageUrls: [] }));
    for (const userId of ["user_1", "user_2"]) {
      mockRequireCurrentUserRecord.mockResolvedValue({ credits: 100, id: userId });
      expect((await POST(new Request("https://app.unit.invalid/api/generate", { method: "POST" }))).status).toBe(200);
    }
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("同用户并发提交4+4只接受一次，不超过5张", async () => {
    const { create, charge } = submissionTransaction();
    mockParseGenerateRequest.mockResolvedValue(buildRequestBody({ generationType: "text_to_image", count: 4, images: [], imageUrls: [] }));
    const responses = await Promise.all([1, 2].map(() => POST(new Request("https://app.unit.invalid/api/generate", { method: "POST" }))));
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 429]);
    expect(mockCheckGenerationInput).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledTimes(1);
  });
});
