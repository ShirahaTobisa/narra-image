import { describe, expect, it } from "vitest";

import { gifOutputProblem } from "@/lib/generation/gif-output";
import { generateSchema } from "@/lib/validators";

const gif = { count: 1, generationType: "text_to_image", model: "gpt-image-2.6-sunburst", outputFormat: "gif", size: "1024x1024" };

describe("动图 GIF 输出", () => {
  it("确认能出的组合放行，别的格式不管", () => {
    expect(gifOutputProblem(gif)).toBeNull();
    expect(gifOutputProblem({ ...gif, model: "gpt-image-2.6-flare", size: "auto" })).toBeNull();
    expect(gifOutputProblem({ count: 4, generationType: "image_to_image", model: "gpt-image-2.5-sunburst", outputFormat: "png", size: "2048x1152" })).toBeNull();
  });

  it("模型、张数、尺寸超出范围时说清原因", () => {
    expect(gifOutputProblem({ ...gif, generationType: "image_to_image" })).toMatch(/只支持文生图/);
    expect(gifOutputProblem({ ...gif, model: "gpt-image-2.5-sunburst" })).toMatch(/只有 gpt-image-2\.6/);
    expect(gifOutputProblem({ ...gif, count: 2 })).toMatch(/一次只能出 1 张/);
    expect(gifOutputProblem({ ...gif, size: "2048x1152" })).toMatch(/1024x1024、1536x1024、1024x1536/);
  });

  it("网页出图接受 gif，并且不带压缩参数（上游不支持）", () => {
    const parsed = generateSchema.parse({ model: "gpt-image-2.6-sunburst", outputCompression: 80, outputFormat: "gif", prompt: "a bouncing ball" });
    expect(parsed.outputFormat).toBe("gif");
    expect(parsed.outputCompression).toBeNull();
  });
});
