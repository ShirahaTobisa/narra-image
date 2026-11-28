import {
  looksLikeImageModel,
  prioritizeModelIds,
  supportsResponsesImageGeneration,
} from "@/lib/providers/model-catalog";
import { filterChannelsByKind } from "@/lib/generation/model-limits";

describe("模型列表整理", () => {
  it("separates public image/video models and keeps wildcard channels out of the catalog", () => {
    const channels = [{ id: "mixed", defaultModel: "gpt-image-2", models: ["seedream-5-5", "h3", "sora-2", " * "] }, { id: "wildcard", defaultModel: "*", models: ["*"] }];
    expect(filterChannelsByKind(channels, "image")).toEqual([{ id: "mixed", defaultModel: "gpt-image-2", models: ["gpt-image-2", "seedream-5-5"] }]);
    expect(filterChannelsByKind(channels, "video")).toEqual([{ id: "mixed", defaultModel: "h3", models: ["h3", "sora-2"] }]);
  });

  it("会优先把更像生图模型的 id 排到前面", () => {
    expect(
      prioritizeModelIds([
        "gpt-4.1-mini",
        "gemini-3-pro-image-preview",
        "gpt-image-1",
        "gemini-2.5-flash",
      ]),
    ).toEqual([
      "gemini-3-pro-image-preview",
      "gpt-image-1",
      "gemini-2.5-flash",
      "gpt-4.1-mini",
    ]);
  });

  it("只把明显的图片模型判定为 imageLikely", () => {
    expect(looksLikeImageModel("gpt-image-1")).toBe(true);
    expect(looksLikeImageModel("gemini-3-pro-image-preview")).toBe(true);
    expect(looksLikeImageModel("gpt-5.5")).toBe(true);
    expect(looksLikeImageModel("seedream-5-5")).toBe(true);
    expect(looksLikeImageModel("h3")).toBe(false);
    expect(looksLikeImageModel("sora-2")).toBe(false);
    expect(looksLikeImageModel("gpt-4.1-mini")).toBe(false);
    expect(looksLikeImageModel("gemini-2.5-flash")).toBe(false);
  });

  it("识别可通过 Responses image_generation 工具生图的主线模型", () => {
    expect(supportsResponsesImageGeneration("gpt-5.5")).toBe(true);
    expect(supportsResponsesImageGeneration("gpt-5.4")).toBe(true);
    expect(supportsResponsesImageGeneration("gpt-5")).toBe(true);
    expect(supportsResponsesImageGeneration("openai/gpt-5.4")).toBe(true);
    expect(supportsResponsesImageGeneration("gpt-image-2")).toBe(false);
    expect(supportsResponsesImageGeneration("gpt-4.1-mini")).toBe(false);
  });
});
