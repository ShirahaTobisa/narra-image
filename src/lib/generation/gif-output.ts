const GIF_SIZES = ["1024x1024", "1536x1024", "1024x1536"];

/**
 * 动图 GIF 目前确认能出的范围：只有 gpt-image-2.6 的模型、一次一张、三种标准尺寸（或自动）。
 * 超出的请求上游会直接失败，而同一渠道连着失败 3 次会被切走，所以提交时先拦下来。
 * 有问题就返回给用户看的原因，没问题返回 null。
 */
export function gifOutputProblem(input: { count: number; model: string; outputFormat?: string | null; size: string }) {
  if (input.outputFormat !== "gif") return null;
  if (!input.model.startsWith("gpt-image-2.6")) return "GIF 动图只有 gpt-image-2.6 模型能出，请换一个模型";
  if (input.count > 1) return "GIF 动图一次只能出 1 张";
  if (input.size !== "auto" && !GIF_SIZES.includes(input.size)) {
    return `GIF 动图目前只支持 ${GIF_SIZES.join("、")} 三种尺寸`;
  }
  return null;
}
