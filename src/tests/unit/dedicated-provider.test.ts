import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { usesDedicatedProvider, dedicatedGenerationSize } from "@/lib/providers/dedicated-provider";
import { channelSupportsModel } from "@/lib/generation/contracts";

const image = { model: "seedream-5-5", generationType: "text_to_image", size: "1024x1024" as const, count: 1, outputFormat: "png" };

describe("dedicated provider admission", () => {
  it("only accepts the configured vendor and model together", () => {
    expect(usesDedicatedProvider({ baseUrl: "https://api.apimart.ai/v1/" }, "seedream-5-5")).toBe(true);
    expect(usesDedicatedProvider({ baseUrl: "https://h3.coolhs.com/api/v1" }, "h3")).toBe(true);
    expect(usesDedicatedProvider({ baseUrl: "https://api.apimart.ai/v1" }, "gpt-image-2")).toBe(false);
  });
  it.each(["https://api.openai.com/v1", "https://api.apimart.ai.example.com/v1", "http://api.apimart.ai/v1", "https://api.apimart.ai/v1?secret=x"])("rejects mismatched dedicated channel %s", (baseUrl) => {
    expect(() => usesDedicatedProvider({ baseUrl }, "seedream-5-5")).toThrow();
  });
  it.each(["seedream-5-5", "h3"])("does not send %s through a GPT wildcard", (model) => {
    expect(channelSupportsModel({ defaultModel: "gpt-image-2", models: ["*"], model })).toBe(false);
    expect(channelSupportsModel({ defaultModel: model, models: [], model })).toBe(true);
  });
  it("keeps existing GPT wildcard routing", () => {
    expect(channelSupportsModel({ defaultModel: "gpt-image-2", models: ["*"], model: "gpt-image-2.6-flare" })).toBe(true);
  });
  it("rejects extra references and multiple outputs before admission", () => {
    expect(() => dedicatedGenerationSize(image, 2)).toThrow("一张参考图");
    expect(() => dedicatedGenerationSize({ ...image, count: 4 }, 0)).toThrow("一个结果");
  });
  it("bounds forged higher resolution requests to 1K while keeping orientation", () => {
    expect(dedicatedGenerationSize({ ...image, size: "3840x3840" }, 0)).toBe("1024x1024");
    expect(dedicatedGenerationSize({ ...image, size: "2048x3072" }, 1)).toBe("1024x1536");
    expect(dedicatedGenerationSize({ ...image, size: "auto" }, 0)).toBe("auto");
  });
  it("rejects wrong media and unsupported formats", () => {
    expect(() => dedicatedGenerationSize({ ...image, outputFormat: "gif" }, 0)).toThrow("PNG 或 JPEG");
    expect(() => dedicatedGenerationSize({ ...image, model: "h3" }, 0)).toThrow("视频页");
  });
  it("limits H3 duration and dimensions and retains its video canvas", () => {
    const video = { ...image, model: "h3", generationType: "text_to_video", size: "1280x736" as const, durationSeconds: 8 };
    expect(dedicatedGenerationSize(video, 0)).toBe("1280x736");
    expect(dedicatedGenerationSize({ ...video, aspectRatio: "1:1", size: "816x816" }, 1)).toBe("736x736");
    expect(() => dedicatedGenerationSize({ ...video, durationSeconds: 12 }, 0)).toThrow("4、6、8");
    expect(() => dedicatedGenerationSize({ ...video, size: "1920x1080" }, 0)).toThrow("1440");
  });
});
