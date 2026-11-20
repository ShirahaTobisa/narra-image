import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDecryptProviderSecret, mockFindUnique, mockUpsert, mockEnv } = vi.hoisted(() => ({
  mockDecryptProviderSecret: vi.fn(),
  mockFindUnique: vi.fn(),
  mockUpsert: vi.fn(),
  mockEnv: {
    AUTH_SECRET: "unit-test-secret", MODERATION_AI_ENABLED: false, MODERATION_API_KEY: "",
    MODERATION_BASE_URL: "", MODERATION_ENABLED: false, MODERATION_MODEL: "omni-moderation-latest",
    MODERATION_SENSITIVE_WORDS_ENABLED: true, MODERATION_THRESHOLD: 0.5,
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: { moderationConfig: { findUnique: mockFindUnique, upsert: mockUpsert } },
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => mockEnv,
}));
vi.mock("@/lib/providers/provider-secret", () => ({
  decryptProviderSecret: mockDecryptProviderSecret,
  encryptProviderSecret: vi.fn(),
}));

import {
  getModerationConfigMeta,
  resolveModerationConfig,
  updateModerationConfig,
} from "@/lib/moderation/config";

describe("审核配置", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockEnv, { MODERATION_ENABLED: false, MODERATION_AI_ENABLED: false, MODERATION_API_KEY: "", MODERATION_BASE_URL: "" });
  });

  it("resolveModerationConfig：DB 优先且解密 key", async () => {
    mockFindUnique.mockResolvedValue({
      aiApiKeyEncrypted: "enc:key",
      aiBaseUrl: "https://x.example/v1",
      aiEnabled: true,
      aiModel: "custom-model",
      aiThreshold: 0.7,
      isEnabled: true,
      scope: "default",
      sensitiveWordsEnabled: false,
      updatedAt: new Date("2026-09-01T00:00:00Z"),
    });
    mockDecryptProviderSecret.mockResolvedValue("plain-key");

    const cfg = await resolveModerationConfig();

    expect(cfg).toEqual({
      aiApiKey: "plain-key",
      aiBaseUrl: "https://x.example/v1",
      aiEnabled: true,
      aiModel: "custom-model",
      aiThreshold: 0.7,
      isEnabled: true,
      sensitiveWordsEnabled: false,
    });
    expect(mockDecryptProviderSecret).toHaveBeenCalledWith(
      "enc:key",
      "unit-test-secret",
    );
  });

  it("无 DB 行时回退 env 默认", async () => {
    mockFindUnique.mockResolvedValue(null);

    const cfg = await resolveModerationConfig();

    expect(cfg).toEqual({
      aiApiKey: null,
      aiBaseUrl: null,
      aiEnabled: false,
      aiModel: "omni-moderation-latest",
      aiThreshold: 0.5,
      isEnabled: false,
      sensitiveWordsEnabled: true,
    });
  });

  it("首次仅调整阈值不会把环境中已启用的审核关掉", async () => {
    Object.assign(mockEnv, {
      MODERATION_ENABLED: true, MODERATION_AI_ENABLED: true,
      MODERATION_API_KEY: "env-key", MODERATION_BASE_URL: "https://moderation.example/v1",
    });
    mockFindUnique.mockResolvedValue(null);
    mockUpsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => {
      const saved = { isEnabled: false, aiEnabled: false, sensitiveWordsEnabled: true,
        aiModel: "text-moderation-latest", aiThreshold: 0.5, ...create };
      mockFindUnique.mockResolvedValue(saved);
      return saved;
    });
    await updateModerationConfig({ aiThreshold: 0.3 });
    expect(await resolveModerationConfig()).toMatchObject({
      isEnabled: true, aiEnabled: true, sensitiveWordsEnabled: true,
      aiBaseUrl: "https://moderation.example/v1", aiApiKey: "env-key",
      aiModel: "omni-moderation-latest", aiThreshold: 0.3,
    });
  });

  it("getModerationConfigMeta 不透出明文或加密 key", async () => {
    mockFindUnique.mockResolvedValue({
      aiApiKeyEncrypted: "enc:key",
      aiBaseUrl: "https://x.example/v1",
      aiEnabled: true,
      aiModel: "custom-model",
      aiThreshold: 0.7,
      isEnabled: true,
      scope: "default",
      sensitiveWordsEnabled: false,
      updatedAt: new Date("2026-09-01T00:00:00Z"),
    });
    mockDecryptProviderSecret.mockResolvedValue("plain-key");

    const meta = await getModerationConfigMeta();

    expect(meta.aiConfigured).toBe(true);
    expect(meta).not.toHaveProperty("aiApiKey");
    expect(meta).not.toHaveProperty("aiApiKeyEncrypted");
    expect(JSON.stringify(meta)).not.toContain("plain-key");
    expect(JSON.stringify(meta)).not.toContain("enc:key");
    expect(meta.aiBaseUrl).toBe("https://x.example/v1");
  });
});
