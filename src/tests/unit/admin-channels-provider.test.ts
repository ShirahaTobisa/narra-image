import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockBuiltInProviderConfigFindFirst,
  mockDecryptProviderSecret,
  mockGenerationJobFindMany,
  mockProviderChannelCreate,
  mockProviderChannelFindFirst,
  mockProviderChannelFindMany,
} =
  vi.hoisted(() => ({
    mockBuiltInProviderConfigFindFirst: vi.fn(),
    mockDecryptProviderSecret: vi.fn(),
    mockGenerationJobFindMany: vi.fn(),
    mockProviderChannelCreate: vi.fn(),
    mockProviderChannelFindFirst: vi.fn(),
    mockProviderChannelFindMany: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  db: {
    builtInProviderConfig: {
      findFirst: mockBuiltInProviderConfigFindFirst,
    },
    generationJob: { findMany: mockGenerationJobFindMany },
    providerChannel: {
      create: mockProviderChannelCreate,
      findFirst: mockProviderChannelFindFirst,
      findMany: mockProviderChannelFindMany,
    },
  },
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    AUTH_SECRET: "unit-test-secret",
    BUILTIN_PROVIDER_VIDEO_CREDIT_COST: 22,
  }),
}));

vi.mock("@/lib/providers/provider-secret", () => ({
  decryptProviderSecret: mockDecryptProviderSecret,
}));

import { getChannelById, getChannelsForAdmin, getGenerationChannelForModel } from "@/lib/providers/built-in-provider";

describe("站内渠道兜底", () => {
  const channel = (id: string, defaultModel: string, models: string[]) => ({
    apiKeyEncrypted: "enc", baseUrl: `https://${id}.example/v1`, creditCost: 5, defaultModel, id,
    isActive: true, models, name: id, slug: id, sortOrder: 0, videoCreditCost: 20,
  });
  const failed = (errorMessage: string) => ({ errorMessage, status: "FAILED" });
  function withHistory(jobs: Array<ReturnType<typeof failed> & { errorCode?: string }>) {
    // 模拟数据库 WHERE 在 LIMIT 之前过滤，包括 SQL NULL 的语义。
    mockGenerationJobFindMany.mockImplementation(({ where, take }) => Promise.resolve(jobs.filter((job) =>
      !where.OR || where.OR.some((filter: { errorCode: { not: string } | null }) =>
        filter.errorCode === null ? job.errorCode == null
          : job.errorCode != null && job.errorCode !== filter.errorCode.not),
    ).slice(0, take)));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDecryptProviderSecret.mockResolvedValue("decrypted-key");
    mockProviderChannelFindMany.mockResolvedValue([
      channel("primary", "gpt-image-2.6-sunburst", ["gpt-image-2.6-flare"]),
      channel("fallback", "gpt-image-2.6", ["*"]),
    ]);
  });

  it("主渠道正常时用主渠道", async () => {
    mockGenerationJobFindMany.mockResolvedValue([{ errorMessage: null, status: "SUCCEEDED" }]);
    await expect(getGenerationChannelForModel("gpt-image-2.6-flare")).resolves.toMatchObject({ id: "primary" });
  });

  it("主渠道最近 3 个任务都失败，就换到兜底渠道", async () => {
    mockGenerationJobFindMany.mockResolvedValue([failed("upstream 502"), failed("timeout"), failed("upstream 503")]);
    await expect(getGenerationChannelForModel("gpt-image-2.6-flare")).resolves.toMatchObject({ id: "fallback" });
  });

  it("被审核拦下的失败不算渠道坏了", async () => {
    mockGenerationJobFindMany.mockResolvedValue([failed("upstream 502"), failed("moderation_blocked"), failed("timeout")]);
    await expect(getGenerationChannelForModel("gpt-image-2.6-flare")).resolves.toMatchObject({ id: "primary" });
  });

  it("取消排队任务不会让全站切换到兜底渠道", async () => {
    withHistory(Array.from({ length: 3 }, () => ({
      ...failed("用户取消生成。"), errorCode: "GENERATION_CANCELLED",
    })));
    await expect(getGenerationChannelForModel("gpt-image-2.6-flare")).resolves.toMatchObject({ id: "primary" });
  });

  it("取消任务不会凑成三个连续渠道故障", async () => {
    withHistory([
      failed("upstream 502"),
      { ...failed("用户取消生成。"), errorCode: "GENERATION_CANCELLED" },
      failed("timeout"),
    ]);
    await expect(getGenerationChannelForModel("gpt-image-2.6-flare")).resolves.toMatchObject({ id: "primary" });
  });

  it("先排除取消再取最近三个结果，取消也不能掩盖真实渠道故障", async () => {
    withHistory([
      { ...failed("用户取消生成。"), errorCode: "GENERATION_CANCELLED" },
      failed("upstream 502"), failed("timeout"), failed("upstream 503"),
    ]);
    await expect(getGenerationChannelForModel("gpt-image-2.6-flare")).resolves.toMatchObject({ id: "fallback" });
  });

  it("主渠道不支持的模型直接由兜底渠道接", async () => {
    await expect(getGenerationChannelForModel("gpt-image-9")).resolves.toMatchObject({ id: "fallback" });
    expect(mockGenerationJobFindMany).not.toHaveBeenCalled();
  });
});

describe("后台渠道列表", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecryptProviderSecret.mockResolvedValue("decrypted-key");
    mockBuiltInProviderConfigFindFirst.mockResolvedValue(null);
  });

  it("按 ID 获取渠道时只查询启用渠道", async () => {
    mockProviderChannelFindFirst.mockResolvedValue(null);

    await expect(getChannelById("channel_disabled")).resolves.toBeNull();

    expect(mockProviderChannelFindFirst).toHaveBeenCalledWith({
      where: { id: "channel_disabled", isActive: true },
    });
    expect(mockDecryptProviderSecret).not.toHaveBeenCalled();
  });

  it("返回启用渠道并解密密钥", async () => {
    mockProviderChannelFindFirst.mockResolvedValue({
      apiKeyEncrypted: "encrypted-key",
      baseUrl: "https://provider.example.com/v1",
      creditCost: 6,
      defaultModel: "gpt-image-1",
      id: "channel_active",
      isActive: true,
      models: ["gpt-image-1"],
      name: "测试渠道",
      videoCreditCost: 26,
    });

    await expect(getChannelById("channel_active")).resolves.toMatchObject({
      apiKey: "decrypted-key",
      id: "channel_active",
    });
  });

  it("返回渠道的视频积分消耗", async () => {
    mockProviderChannelFindMany.mockResolvedValue([
      {
        apiKeyEncrypted: "encrypted-key",
        baseUrl: "https://provider.example.com/v1",
        creditCost: 6,
        defaultModel: "gpt-image-1",
        id: "channel_1",
        isActive: true,
        models: ["gpt-image-1"],
        name: "测试渠道",
        slug: "test-channel",
        sortOrder: 0,
        videoCreditCost: 26,
      },
    ]);

    await expect(getChannelsForAdmin()).resolves.toEqual([
      expect.objectContaining({
        creditCost: 6,
        id: "channel_1",
        videoCreditCost: 26,
      }),
    ]);
  });

  it("迁移旧配置时使用环境默认视频积分消耗", async () => {
    mockProviderChannelFindMany.mockResolvedValue([]);
    mockBuiltInProviderConfigFindFirst.mockResolvedValue({
      apiKeyEncrypted: "encrypted-key",
      baseUrl: "https://legacy.example.com/v1",
      creditCost: 5,
      model: "gpt-image-1",
      models: ["gpt-image-1"],
      name: "旧渠道",
    });
    mockProviderChannelCreate.mockResolvedValue({
      apiKeyEncrypted: "encrypted-key",
      baseUrl: "https://legacy.example.com/v1",
      creditCost: 5,
      defaultModel: "gpt-image-1",
      id: "channel_legacy",
      isActive: true,
      models: ["gpt-image-1"],
      name: "旧渠道",
      slug: "default",
      sortOrder: 0,
      videoCreditCost: 22,
    });

    await getChannelsForAdmin();

    expect(mockProviderChannelCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        videoCreditCost: 22,
      }),
    });
  });
});
