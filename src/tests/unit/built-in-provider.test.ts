import {
  mergeBuiltInProviderConfigInput,
  mergeChannelsForUsers,
  resolveBuiltInProviderConfig,
} from "@/lib/providers/built-in-provider-core";

describe("给用户看的渠道", () => {
  it("所有渠道合成一个平台渠道，只露出模型，不露渠道名和 ID", () => {
    const merged = mergeChannelsForUsers([
      { creditCost: 5, defaultModel: "gpt-image-2", id: "ch_upstream", models: ["gpt-image-2"], name: "上游中转" },
      { creditCost: 9, defaultModel: "gpt-image-2", id: "ch_backup", models: ["gpt-image-2.5"], name: "官方 key 兜底" },
      { creditCost: 0, defaultModel: "gpt-image-2.6", id: "ch_fallback", models: ["*"], name: "chatgpt2api" },
    ]);
    // 兜底渠道的 "*" 不会出现在用户看到的模型里
    expect(merged).toEqual([
      { creditCost: 5, defaultModel: "gpt-image-2", id: "", models: ["gpt-image-2", "gpt-image-2.5", "gpt-image-2.6"], name: "平台渠道" },
    ]);
    expect(mergeChannelsForUsers([])).toEqual([]);
  });
});

describe("内置渠道配置", () => {
  it("存在后台配置时，优先使用后台配置", () => {
    const config = resolveBuiltInProviderConfig(
      {
        apiKey: "env-key",
        baseUrl: "https://env.example.com/v1",
        creditCost: 5,
        model: "gpt-image-1",
        models: [],
        name: "Env Provider",
      },
      {
        apiKey: "db-key",
        baseUrl: "https://db.example.com/v1",
        creditCost: 12,
        model: "gemini-2.5-flash-image",
        models: [],
        name: "DB Provider",
      },
    );

    expect(config).toEqual({
      apiKey: "db-key",
      baseUrl: "https://db.example.com/v1",
      creditCost: 12,
      model: "gemini-2.5-flash-image",
      models: [],
      name: "DB Provider",
    });
  });

  it("留空 API Key 时保留旧密钥，但允许更新其他字段", () => {
    const merged = mergeBuiltInProviderConfigInput(
      {
        apiKey: "",
        baseUrl: "https://new.example.com/v1",
        creditCost: 8,
        model: "gpt-image-1",
        models: [],
        name: "Studio New",
      },
      {
        apiKeyEncrypted: "encrypted-old-key",
        baseUrl: "https://old.example.com/v1",
        creditCost: 5,
        model: "old-model",
        models: [],
        name: "Studio Old",
      },
    );

    expect(merged).toEqual({
      apiKey: null,
      baseUrl: "https://new.example.com/v1",
      creditCost: 8,
      model: "gpt-image-1",
      models: [],
      name: "Studio New",
    });
  });
});
