import { normalizeProviderModels } from "@/lib/generation/contracts";

/**
 * 给用户看的渠道：所有可用渠道合成一个"平台渠道"，只露出模型，不露渠道名和 ID。
 * 具体走哪条由服务器按后台排序，挑第一条支持这个模型的（见 getGenerationChannelForModel）。
 */
export function mergeChannelsForUsers<T extends { defaultModel: string; id: string; models: string[]; name: string }>(
  channels: T[],
): T[] {
  const [first] = channels;
  if (!first) return [];
  const models = [...new Set(channels.flatMap((channel) => normalizeProviderModels(channel.defaultModel, channel.models)))];
  return [{ ...first, id: "", models, name: "平台渠道" }];
}

type BasicBuiltInProviderConfig = {
  apiKey: string;
  baseUrl: string;
  creditCost: number;
  model: string;
  models: string[];
  name: string;
};

type StoredBuiltInProviderConfig = {
  apiKeyEncrypted: string;
  baseUrl: string;
  creditCost: number;
  model: string;
  models: string[];
  name: string;
};

type BuiltInProviderInput = {
  apiKey: string;
  baseUrl: string;
  creditCost: number;
  model: string;
  models: string[];
  name: string;
};

export function resolveBuiltInProviderConfig(
  envConfig: BasicBuiltInProviderConfig,
  dbConfig: BasicBuiltInProviderConfig | null,
) {
  return dbConfig ?? envConfig;
}

export function mergeBuiltInProviderConfigInput(
  input: BuiltInProviderInput,
  _current: StoredBuiltInProviderConfig | null,
) {
  void _current;

  return {
    apiKey: input.apiKey.trim() ? input.apiKey.trim() : null,
    baseUrl: input.baseUrl,
    creditCost: input.creditCost,
    model: input.model,
    models: input.models,
    name: input.name,
  };
}
