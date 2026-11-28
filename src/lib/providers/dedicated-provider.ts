import "server-only";

import { GenerationContractError } from "@/lib/generation/contracts";
import { getDedicatedModelLimits } from "@/lib/generation/model-limits";
import { calculateImageSize, parseImageSize, type GenerationSizeToken } from "@/lib/generation/sizes";

/** Only a server-selected, explicitly supported vendor/model pair may use its own content policy. */
export function usesDedicatedProvider(channel: { baseUrl: string }, model: string): boolean {
  if (!getDedicatedModelLimits(model)) return false;
  const url = new URL(channel.baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const secure = url.protocol === "https:" && !url.port && !url.username && !url.password && !url.search && !url.hash;
  const supported = secure && (
    model === "seedream-5-5" && url.hostname === "api.apimart.ai" && path === "/v1"
    || model === "h3" && url.hostname === "h3.coolhs.com" && ["", "/v1", "/api/v1"].includes(path)
  );
  if (!supported) throw new GenerationContractError("MODEL_NOT_SUPPORTED_BY_CHANNEL");
  return true;
}

type DedicatedInput = {
  model?: string | null;
  generationType: string;
  count: number;
  size: GenerationSizeToken;
  outputFormat: string;
  durationSeconds?: number | null;
  aspectRatio?: string | null;
};

/** Enforce input limits before uploads, billing or queuing; return the bounded requested size. */
export function dedicatedGenerationSize(input: DedicatedInput, referenceCount: number): GenerationSizeToken {
  const limits = getDedicatedModelLimits(input.model ?? "");
  if (!limits) return input.size;
  if ((limits.kind === "video") !== input.generationType.endsWith("_video")) {
    throw new Error(limits.kind === "video" ? "H3 请在视频页使用" : "Seedream 5.5 只支持图片生成");
  }
  if (referenceCount > limits.maxReferenceImages) throw new Error("此模型最多支持一张参考图");
  if (input.count > limits.maxOutputs) throw new Error("此模型每次只能生成一个结果");
  if (limits.kind === "image") {
    if (!limits.formats?.includes(input.outputFormat)) throw new Error("Seedream 5.5 仅支持 PNG 或 JPEG");
    return input.size === "auto" ? "auto" : calculateImageSize("1K", input.size) ?? "1024x1024";
  }
  if (!limits.durations?.includes(input.durationSeconds ?? 8)) throw new Error("H3 时长仅支持 4、6、8 秒");
  const pixels = input.size === "auto" ? null : parseImageSize(input.size);
  if (pixels && Math.max(pixels.width, pixels.height) > limits.maxEdge!) throw new Error("H3 视频最长边不能超过 1440 像素");
  const sizes: Record<string, GenerationSizeToken> = { "16:9": "1280x736", "9:16": "736x1280", "1:1": "736x736" };
  return sizes[input.aspectRatio ?? ""] ?? (input.size === "auto" ? "1280x736" : input.size);
}
