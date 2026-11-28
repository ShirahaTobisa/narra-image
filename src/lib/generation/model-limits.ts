import catalog from "../../../contracts/generation/v1/dedicated-models.json";
import { calculateImageSize } from "./sizes";
import type { GenerationOutputFormat, GenerationSizeToken } from "@/lib/types";

export function getDedicatedModelLimits(model: string) {
  return catalog.models.find((entry) => entry.model === model.trim());
}

export function isDedicatedModel(model: string) {
  return Boolean(getDedicatedModelLimits(model));
}

export function isVideoModel(model: string) {
  return getDedicatedModelLimits(model)?.kind === "video" || /(?:^|\/)sora(?:-|$)|video|seedance|kling|veo/i.test(model);
}

export function filterChannelsByKind<T extends { defaultModel: string; models: string[] }>(channels: T[], kind: "image" | "video"): T[] {
  return channels.flatMap((channel) => {
    const models = [...new Set([channel.defaultModel, ...channel.models].map((model) => model.trim()))]
      .filter((model) => model && model !== "*" && isVideoModel(model) === (kind === "video"));
    return models.length ? [{ ...channel, models, defaultModel: models.includes(channel.defaultModel.trim()) ? channel.defaultModel.trim() : models[0] }] : [];
  });
}

export function constrainImageModelParameters<T extends { model: string; size: GenerationSizeToken; count: number; outputFormat: GenerationOutputFormat }>(parameters: T): T {
  const limits = getDedicatedModelLimits(parameters.model);
  if (limits?.kind !== "image") return parameters;
  return {
    ...parameters,
    size: limits.resolution === "1K" ? calculateImageSize("1K", parameters.size) ?? "1024x1024" : parameters.size,
    count: Math.min(parameters.count, limits.maxOutputs),
    outputFormat: limits.formats?.includes(parameters.outputFormat) ? parameters.outputFormat : "png",
  };
}
