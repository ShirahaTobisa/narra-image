// @vitest-environment node

import channelScenarios from "../../../../contracts/generation/v1/scenarios/channels.json";
import lifecycleScenarios from "../../../../contracts/generation/v1/scenarios/lifecycle.json";
import {
  GENERATION_ERRORS,
  channelSupportsModel,
  isGenerationErrorCode,
  isGenerationRefundAllowed,
} from "@/lib/generation/contracts";

describe("worker contract v1 shared scenarios", () => {
  it("渠道 fixture 的允许结果与 Node 模型校验一致", () => {
    for (const scenario of channelScenarios.scenarios) {
      if (!scenario.channel) {
        expect(scenario.result.errorCode).toBe("CHANNEL_NOT_FOUND");
        continue;
      }
      if (!scenario.channel.active) {
        expect(scenario.result.errorCode).toBe("CHANNEL_INACTIVE");
        continue;
      }

      expect(channelSupportsModel({
        defaultModel: scenario.channel.defaultModel,
        model: scenario.requestedModel,
        models: scenario.channel.models,
      })).toBe(scenario.result.errorCode === null);
    }
  });

  it("生命周期 fixture 只引用已注册的稳定错误码", () => {
    for (const scenario of lifecycleScenarios.scenarios) {
      const errorCode = "errorCode" in scenario.result
        ? scenario.result.errorCode
        : undefined;
      if (typeof errorCode === "string") {
        expect(isGenerationErrorCode(errorCode)).toBe(true);
      }
    }
  });

  it("取消、等待超时和未知 handoff 的退款决策一致", () => {
    const submitting = lifecycleScenarios.scenarios.find(
      (scenario) => scenario.id === "WC-C03-submitting",
    );
    const submitted = lifecycleScenarios.scenarios.find(
      (scenario) => scenario.id === "WC-C03-submitted",
    );
    const timeout = lifecycleScenarios.scenarios.find(
      (scenario) => scenario.id === "WC-C04",
    );
    const unknown = lifecycleScenarios.scenarios.find(
      (scenario) => scenario.id === "WC-B07",
    );

    expect(submitting?.result).toMatchObject({ conflict: true, refund: false });
    expect(submitted?.result).toMatchObject({ conflict: true, refund: false });
    expect(timeout?.result).toMatchObject({
      errorCode: "GENERATION_WAIT_TIMEOUT",
      jobChanged: false,
      refund: false,
    });
    expect(unknown?.result).toMatchObject({
      errorCode: "HANDOFF_UNKNOWN",
      refund: false,
      retry: false,
    });

    for (const handoffState of ["SUBMITTING", "SUBMITTED", "UNKNOWN"] as const) {
      expect(isGenerationRefundAllowed({
        contractVersion: 1,
        handoffState,
      })).toBe(false);
    }
    expect(GENERATION_ERRORS.GENERATION_CANCELLED.refundable).toBe(true);
    expect(GENERATION_ERRORS.GENERATION_WAIT_TIMEOUT.refundable).toBe(false);
  });

  it("封禁只取消首次发送前的任务，legacy 和 v1 均保留已发送任务", () => {
    for (const scenario of lifecycleScenarios.scenarios) {
      if (!("contractVersion" in scenario) || scenario.contractVersion === undefined) continue;
      if (scenario.action === "ban_before_submit") {
        expect(scenario.result).toMatchObject({ errorCode: "GENERATION_CANCELLED", refund: true, upstreamRequests: 0 });
        if (scenario.handoffState !== null && scenario.handoffState !== "NOT_STARTED") throw new Error("发送前封禁 fixture 状态错误");
        expect(isGenerationRefundAllowed({ contractVersion: scenario.contractVersion, handoffState: scenario.handoffState })).toBe(true);
      } else if (scenario.action === "ban_after_submit") {
        expect(scenario.result).toEqual({ jobChanged: false, refund: false });
      }
    }
  });
});
