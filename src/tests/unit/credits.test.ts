import {
  calculateGenerationCost,
  hasEnoughCredits,
  resolveCreditCost,
  resolveGenerationCount,
  shouldChargeCredits,
} from "@/lib/credits";

describe("积分规则", () => {
  it("内置渠道按实际输出张数计费", () => {
    expect(
      calculateGenerationCost({
        providerMode: "built_in",
        builtInCreditCost: 5,
        count: 4,
      }),
    ).toBe(20);
  });

  it("自填渠道不扣积分", () => {
    expect(
      calculateGenerationCost({
        providerMode: "custom",
        builtInCreditCost: 5,
        count: 4,
      }),
    ).toBe(0);
  });

  it("只有内置渠道需要扣积分", () => {
    expect(shouldChargeCredits("built_in")).toBe(true);
    expect(shouldChargeCredits("custom")).toBe(false);
  });

  it("积分不足时禁止内置渠道生成", () => {
    expect(
      hasEnoughCredits({
        providerMode: "built_in",
        credits: 4,
        builtInCreditCost: 5,
        count: 1,
      }),
    ).toBe(false);
  });

  it("4 张单价 5 的请求，余额 19 不够、20 足够", () => {
    const input = { providerMode: "built_in" as const, builtInCreditCost: 5, count: 4 };
    expect(hasEnoughCredits({ ...input, credits: 19 })).toBe(false);
    expect(hasEnoughCredits({ ...input, credits: 20 })).toBe(true);
  });

  it.each([1, 2, 3, 4])("文生图保留 %i 张批次", (count) => {
    expect(resolveGenerationCount({ generationType: "text_to_image", count })).toBe(count);
  });

  it.each(["image_to_image", "text_to_video", "image_to_video"] as const)(
    "%s 忽略伪造的批次数，只按一次输出计费",
    (generationType) => {
      const count = resolveGenerationCount({ generationType, count: 4 });
      const builtInCreditCost = resolveCreditCost({ generationType, imageCreditCost: 5, videoCreditCost: 20 });
      expect(count).toBe(1);
      expect(calculateGenerationCost({ providerMode: "built_in", builtInCreditCost, count }))
        .toBe(generationType === "image_to_image" ? 5 : 20);
    },
  );

  it("视频生成类型取视频单价，图片类型取图片单价", () => {
    expect(
      resolveCreditCost({ generationType: "text_to_video", imageCreditCost: 5, videoCreditCost: 20 }),
    ).toBe(20);
    expect(
      resolveCreditCost({ generationType: "image_to_video", imageCreditCost: 5, videoCreditCost: 20 }),
    ).toBe(20);
    expect(
      resolveCreditCost({ generationType: "text_to_image", imageCreditCost: 5, videoCreditCost: 20 }),
    ).toBe(5);
    expect(
      resolveCreditCost({ generationType: "image_to_image", imageCreditCost: 5, videoCreditCost: 20 }),
    ).toBe(5);
  });
});
